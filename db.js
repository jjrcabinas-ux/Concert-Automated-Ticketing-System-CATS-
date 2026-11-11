// Database + business rules. Money is stored in centavos (integers) to avoid rounding errors.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'tickets.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, event_date TEXT NOT NULL, venue TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', on_sale INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_types (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL, price INTEGER NOT NULL, capacity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  buyer_name TEXT NOT NULL, mobile TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL,            -- 'online' | 'cash'
  payment_ref TEXT, received_by TEXT,
  status TEXT NOT NULL,                    -- 'pending' | 'paid' | 'cancelled' | 'refunded'
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT, paid_at TEXT, closed_at TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  qty INTEGER NOT NULL, unit_price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
  status TEXT NOT NULL DEFAULT 'valid',    -- 'valid' | 'used' | 'void'
  checked_in_at TEXT, checked_in_by TEXT
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id),
  spent_on TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
  amount INTEGER NOT NULL, recorded_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
`);

// Columns added for the payment gateway (safe to re-run on an existing database).
for (const col of ['gateway_id TEXT', 'gateway_url TEXT', 'gateway_open INTEGER NOT NULL DEFAULT 0', 'gateway_fee INTEGER NOT NULL DEFAULT 0'])
  try { db.exec('ALTER TABLE orders ADD COLUMN ' + col); } catch { /* already there */ }

const now = () => new Date().toISOString();
const q = (sql) => db.prepare(sql);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- users / sessions ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkLogin(username, pw) {
  const u = q('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!u) return false;
  const [salt, hash] = u.pass_hash.split(':');
  const test = crypto.scryptSync(String(pw || '').trim(), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex')) ? u.username : false;
}
function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  q('INSERT INTO sessions VALUES (?,?,?)').run(token, username, new Date(Date.now() + 12 * 3600e3).toISOString());
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const s = q('SELECT * FROM sessions WHERE token = ? AND expires_at > ?').get(token, now());
  return s ? s.username : null;
}
const destroySession = (token) => q('DELETE FROM sessions WHERE token = ?').run(token);

// ---------- first-run seed ----------
function seed() {
  if (!q('SELECT 1 FROM users').get()) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    q('INSERT INTO users (username, pass_hash) VALUES (?,?)').run('admin', hashPassword(pw));
    fs.writeFileSync(path.join(DATA_DIR, 'admin-credentials.txt'),
      `Admin login for /admin\nusername: admin\npassword: ${pw}\n`);
    console.log('Admin account created. Credentials saved to data/admin-credentials.txt');
  }
  if (!q('SELECT 1 FROM events').get()) {
    const r = q('INSERT INTO events (name, event_date, venue, description, created_at) VALUES (?,?,?,?,?)')
      .run('Barangay Fiesta Concert 2026', '2026-12-19T19:00', 'Barangay Covered Court',
        'A night of live music from local bands to celebrate our barangay fiesta. Gates open at 5:30 PM.', now());
    const add = q('INSERT INTO ticket_types (event_id, name, price, capacity) VALUES (?,?,?,?)');
    add.run(r.lastInsertRowid, 'VIP (front rows, reserved seat)', 50000, 50);
    add.run(r.lastInsertRowid, 'Regular (seated)', 20000, 300);
    add.run(r.lastInsertRowid, 'General Admission (standing)', 10000, 500);
  }
}
seed();

// ---------- catalogue ----------
const listEvents = (onlyOnSale) =>
  q(`SELECT * FROM events ${onlyOnSale ? 'WHERE on_sale = 1' : ''} ORDER BY event_date`).all();
const getEvent = (id) => q('SELECT * FROM events WHERE id = ?').get(id);

// Ticket types with live availability. Pending (unpaid) orders hold stock until they expire.
function ticketTypes(eventId) {
  return q(`
    SELECT t.*,
      COALESCE((SELECT SUM(i.qty) FROM order_items i JOIN orders o ON o.id = i.order_id
                WHERE i.ticket_type_id = t.id AND o.status = 'paid'), 0) AS sold,
      COALESCE((SELECT SUM(i.qty) FROM order_items i JOIN orders o ON o.id = i.order_id
                WHERE i.ticket_type_id = t.id AND o.status = 'pending'), 0) AS held
    FROM ticket_types t WHERE t.event_id = ? ORDER BY t.price DESC`).all(eventId)
    .map((t) => ({ ...t, available: Math.max(0, t.capacity - t.sold - t.held) }));
}

// ---------- orders ----------
const MAX_PER_ORDER = 10;
const ONLINE_HOLD_MIN = 20;     // minutes to finish an online payment
const CASH_HOLD_HOURS = 48;     // hours to pay at the barangay hall

const randCode = (n) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, easy to read aloud
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
};

function expireOrders() {
  return q(`UPDATE orders SET status = 'cancelled', closed_at = ?, note = 'Expired unpaid (automatic)'
            WHERE status = 'pending' AND expires_at < ?`).run(now(), now()).changes;
}

function createOrder({ eventId, buyerName, mobile, address, paymentMethod, quantities }) {
  return tx(() => {
    expireOrders();
    const ev = getEvent(eventId);
    if (!ev || !ev.on_sale) throw new UserError('Ticket sales for this event are closed.');
    const types = ticketTypes(eventId);
    let total = 0, count = 0;
    const lines = [];
    for (const t of types) {
      const qty = quantities[t.id] || 0;
      if (!qty) continue;
      if (qty > t.available) throw new UserError(`Only ${t.available} "${t.name}" ticket(s) left.`);
      lines.push({ t, qty });
      total += qty * t.price; count += qty;
    }
    if (!count) throw new UserError('Please choose at least one ticket.');
    if (count > MAX_PER_ORDER) throw new UserError(`Maximum of ${MAX_PER_ORDER} tickets per order.`);
    const hold = paymentMethod === 'cash' ? CASH_HOLD_HOURS * 3600e3 : ONLINE_HOLD_MIN * 60e3;
    const token = crypto.randomBytes(16).toString('hex');
    const r = q(`INSERT INTO orders (ref, token, event_id, buyer_name, mobile, address, payment_method, status, total, created_at, expires_at)
                 VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`)
      .run('BC-' + randCode(6), token, eventId, buyerName, mobile, address, paymentMethod, total, now(),
        new Date(Date.now() + hold).toISOString());
    const addItem = q('INSERT INTO order_items (order_id, ticket_type_id, qty, unit_price) VALUES (?,?,?,?)');
    for (const { t, qty } of lines) addItem.run(r.lastInsertRowid, t.id, qty, t.price);
    return token;
  });
}

// Marks an order paid and issues its tickets. Safe to call twice (e.g. duplicate payment callbacks).
const markPaid = (orderId, opts) => tx(() => payOrder(orderId, opts));
function payOrder(orderId, { paymentRef, receivedBy, fee = 0 }) {
  {
    const o = q('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new UserError('Order not found.');
    if (o.status === 'paid') return o;
    if (o.status !== 'pending') throw new UserError(`Order is ${o.status} and can no longer be paid.`);
    q(`UPDATE orders SET status = 'paid', paid_at = ?, payment_ref = ?, received_by = ?, gateway_fee = ?, gateway_open = 0 WHERE id = ?`)
      .run(now(), paymentRef || null, receivedBy || null, fee, orderId);
    const addTicket = q('INSERT INTO tickets (code, order_id, ticket_type_id) VALUES (?,?,?)');
    for (const it of q('SELECT * FROM order_items WHERE order_id = ?').all(orderId))
      for (let n = 0; n < it.qty; n++) addTicket.run(randCode(10), orderId, it.ticket_type_id);
    return o;
  }
}

// ---------- payment gateway bookkeeping ----------
const setGateway = (orderId, id, url) =>
  q('UPDATE orders SET gateway_id = ?, gateway_url = ?, gateway_open = 1 WHERE id = ?').run(id, url, orderId);
const closeGateway = (orderId) => q('UPDATE orders SET gateway_open = 0 WHERE id = ?').run(orderId);
const orderByGateway = (gatewayId) => q('SELECT id FROM orders WHERE gateway_id = ?').get(gatewayId);
const noteOrder = (orderId, note) => q('UPDATE orders SET note = ? WHERE id = ?').run(note, orderId);
// Checkout pages still open at the provider for orders whose payment window has lapsed.
const staleGatewayOrders = () => q(`SELECT id FROM orders WHERE gateway_open = 1 AND status IN ('pending','cancelled')
  AND (status = 'cancelled' OR expires_at < ?)`).all(now());

// Records a confirmed gateway payment. Idempotent. If the money arrives after the order's hold expired,
// the order is reinstated when seats are still free; otherwise { needsRefund: true } tells the caller to send the money back.
function settlePayment(orderId, { paymentRef, fee }) {
  return tx(() => {
    const o = q('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new UserError('Order not found.');
    if (o.status === 'paid') return { ok: true };
    if (o.status === 'refunded') return { ok: false };
    if (o.status === 'cancelled') {
      if (o.payment_ref === paymentRef) return { ok: false };           // already handled this late payment
      const types = ticketTypes(o.event_id);
      const fits = q('SELECT * FROM order_items WHERE order_id = ?').all(orderId)
        .every((i) => types.find((t) => t.id === i.ticket_type_id).available >= i.qty);
      if (!fits) {
        q('UPDATE orders SET payment_ref = ?, gateway_open = 0, note = ? WHERE id = ?')
          .run(paymentRef, 'Paid after the hold expired and tickets were sold out — refund required', orderId);
        return { ok: false, needsRefund: true };
      }
      q(`UPDATE orders SET status = 'pending', closed_at = NULL, note = 'Paid after hold expired — reinstated' WHERE id = ?`).run(orderId);
    }
    payOrder(orderId, { paymentRef, fee });
    return { ok: true };
  });
}

function assertRefundable(orderId) {
  const o = q('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.status !== 'paid') throw new UserError('Only paid orders can be refunded.');
  if (q(`SELECT COUNT(*) n FROM tickets WHERE order_id = ? AND status = 'used'`).get(orderId).n)
    throw new UserError('Cannot refund: a ticket from this order was already used at the gate.');
  return o;
}

function cancelOrder(orderId, by) {
  const r = q(`UPDATE orders SET status = 'cancelled', closed_at = ?, note = ? WHERE id = ? AND status = 'pending'`)
    .run(now(), `Cancelled by ${by}`, orderId);
  if (!r.changes) throw new UserError('Only unpaid orders can be cancelled.');
}

function refundOrder(orderId, by) {
  tx(() => {
    const used = q(`SELECT COUNT(*) n FROM tickets WHERE order_id = ? AND status = 'used'`).get(orderId).n;
    if (used) throw new UserError('Cannot refund: a ticket from this order was already used at the gate.');
    const r = q(`UPDATE orders SET status = 'refunded', closed_at = ?, note = ? WHERE id = ? AND status = 'paid'`)
      .run(now(), `Refunded by ${by}`, orderId);
    if (!r.changes) throw new UserError('Only paid orders can be refunded.');
    q(`UPDATE tickets SET status = 'void' WHERE order_id = ?`).run(orderId);
  });
}

function orderDetail(where, value) {
  const o = q(`SELECT o.*, e.name AS event_name, e.event_date, e.venue FROM orders o
               JOIN events e ON e.id = o.event_id WHERE o.${where} = ?`).get(value);
  if (!o) return null;
  o.items = q(`SELECT i.*, t.name FROM order_items i JOIN ticket_types t ON t.id = i.ticket_type_id
               WHERE i.order_id = ?`).all(o.id);
  o.tickets = q(`SELECT k.*, t.name FROM tickets k JOIN ticket_types t ON t.id = k.ticket_type_id
                 WHERE k.order_id = ? ORDER BY k.id`).all(o.id);
  return o;
}

function findOrder(ref, mobile) {
  return q('SELECT token FROM orders WHERE ref = ? AND mobile = ?').get(ref, mobile);
}

function listOrders(eventId, { status, search } = {}) {
  let sql = `SELECT o.*, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) AS qty
             FROM orders o WHERE o.event_id = ?`;
  const args = [eventId];
  if (status) { sql += ' AND o.status = ?'; args.push(status); }
  if (search) {
    sql += ' AND (o.ref LIKE ? OR o.buyer_name LIKE ? OR o.mobile LIKE ?)';
    args.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  return q(sql + ' ORDER BY o.id DESC LIMIT 500').all(...args);
}

// ---------- gate check-in ----------
function checkIn(code, by) {
  return tx(() => {
    const t = q(`SELECT k.*, tt.name AS type_name, o.buyer_name, o.ref, e.name AS event_name
                 FROM tickets k JOIN ticket_types tt ON tt.id = k.ticket_type_id
                 JOIN orders o ON o.id = k.order_id JOIN events e ON e.id = o.event_id
                 WHERE k.code = ?`).get(code);
    if (!t) return { ok: false, message: 'Ticket not found. Check the code.' };
    if (t.status === 'void') return { ok: false, message: 'Ticket was refunded / voided.', ticket: t };
    if (t.status === 'used') return { ok: false, message: 'ALREADY USED', ticket: t };
    q(`UPDATE tickets SET status = 'used', checked_in_at = ?, checked_in_by = ? WHERE id = ?`).run(now(), by, t.id);
    return { ok: true, message: 'Valid — admit one', ticket: t };
  });
}

// ---------- expenses ----------
const listExpenses = (eventId) => q('SELECT * FROM expenses WHERE event_id = ? ORDER BY spent_on DESC, id DESC').all(eventId);
const addExpense = (e) => q(`INSERT INTO expenses (event_id, spent_on, category, description, amount, recorded_by, created_at)
  VALUES (?,?,?,?,?,?,?)`).run(e.eventId, e.spentOn, e.category, e.description, e.amount, e.by, now());
const deleteExpense = (id) => q('DELETE FROM expenses WHERE id = ?').run(id);

// ---------- financial report (always computed live from the transactions) ----------
const manilaDate = (iso) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10);

function financeReport(eventId) {
  expireOrders();
  const sum = (sql, ...a) => q(sql).get(...a);
  const paid = sum(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amt FROM orders WHERE event_id = ? AND status = 'paid'`, eventId);
  const refunded = sum(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amt FROM orders WHERE event_id = ? AND status = 'refunded'`, eventId);
  const pending = sum(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amt FROM orders WHERE event_id = ? AND status = 'pending'`, eventId);
  const types = ticketTypes(eventId).map((t) => ({ ...t, revenue: q(
    `SELECT COALESCE(SUM(i.qty * i.unit_price),0) v FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE i.ticket_type_id = ? AND o.status = 'paid'`).get(t.id).v }));
  const byMethod = q(`SELECT payment_method, COUNT(*) n, SUM(total) amt FROM orders
                      WHERE event_id = ? AND status = 'paid' GROUP BY payment_method`).all(eventId);
  const cashByStaff = q(`SELECT COALESCE(received_by,'(unknown)') staff, COUNT(*) n, SUM(total) amt FROM orders
                         WHERE event_id = ? AND status = 'paid' AND payment_method = 'cash' GROUP BY received_by`).all(eventId);
  const expByCat = q(`SELECT category, COUNT(*) n, SUM(amount) amt FROM expenses WHERE event_id = ?
                      GROUP BY category ORDER BY amt DESC`).all(eventId);
  const expenses = expByCat.reduce((s, r) => s + r.amt, 0);
  // Fees the payment provider kept from online payments (not returned when an order is refunded).
  const gatewayFees = sum(`SELECT COALESCE(SUM(gateway_fee),0) v FROM orders WHERE event_id = ? AND status IN ('paid','refunded')`, eventId).v;
  const daily = {};
  for (const o of q(`SELECT o.paid_at, o.total, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) qty
                     FROM orders o WHERE o.event_id = ? AND o.status = 'paid'`).all(eventId)) {
    const d = (daily[manilaDate(o.paid_at)] ||= { orders: 0, tickets: 0, amt: 0 });
    d.orders++; d.tickets += o.qty; d.amt += o.total;
  }
  const gate = sum(`SELECT COALESCE(SUM(k.status = 'used'),0) used, COALESCE(SUM(k.status != 'void'),0) issued
                    FROM tickets k JOIN orders o ON o.id = k.order_id WHERE o.event_id = ?`, eventId);
  return {
    grossSales: paid.amt + refunded.amt, refunds: refunded.amt, refundCount: refunded.n,
    netSales: paid.amt, paidOrders: paid.n, pending, expenses, gatewayFees, netIncome: paid.amt - gatewayFees - expenses,
    ticketsSold: types.reduce((s, t) => s + t.sold, 0), capacity: types.reduce((s, t) => s + t.capacity, 0),
    types, byMethod, cashByStaff, expByCat, gate,
    daily: Object.entries(daily).sort().map(([date, d]) => ({ date, ...d })),
  };
}

class UserError extends Error {}

module.exports = {
  db, q, UserError, MAX_PER_ORDER, ONLINE_HOLD_MIN, CASH_HOLD_HOURS,
  checkLogin, createSession, sessionUser, destroySession,
  listEvents, getEvent, ticketTypes, expireOrders, createOrder, markPaid, cancelOrder, refundOrder,
  setGateway, closeGateway, orderByGateway, noteOrder, staleGatewayOrders, settlePayment, assertRefundable,
  orderDetail, findOrder, listOrders, checkIn, listExpenses, addExpense, deleteExpense, financeReport, now,
};
