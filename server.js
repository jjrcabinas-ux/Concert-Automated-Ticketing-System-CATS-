const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file: demo payment mode */ }
const express = require('express');
const QRCode = require('qrcode');
const D = require('./db');
const PM = require('./paymongo');
const { esc, peso, fmtDateTime, fmtEventDate, METHOD, badge, page } = require('./views');

const app = express();
app.disable('x-powered-by');
if (process.env.PUBLIC_URL) app.set('trust proxy', true);   // hosts put an HTTPS proxy in front of the app
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const HTTPS = /^https:/.test(process.env.PUBLIC_URL || '');
// The demo payment button hands out free tickets, so it only exists on a local test copy, never on the hosted site.
const DEMO_OK = process.env.ALLOW_DEMO_PAYMENTS === '1' || (!process.env.PUBLIC_URL && process.env.NODE_ENV !== 'production');
const onlineAvailable = () => PM.enabled() || DEMO_OK;
const payMode = () => PM.enabled() ? 'PayMongo ' + PM.mode() : DEMO_OK ? 'DEMO' : 'OFF (cash only until PayMongo keys are added)';

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  if (HTTPS) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.get('/healthz', (req, res) => res.send('ok'));     // for the host's uptime check

// Applies a PayMongo checkout session to our order: issues tickets if it was paid. Safe to call repeatedly.
async function settleFromSession(orderId, session) {
  const pay = PM.paidPayment(session);
  if (!pay) return false;
  const o = D.orderDetail('id', orderId);
  if (pay.attributes.amount !== o.total) {
    console.error(`Amount mismatch on ${o.ref}: paid ${pay.attributes.amount}, expected ${o.total}`);
    D.noteOrder(o.id, `Payment ${pay.id} amount does not match the order — check manually`);
    return false;
  }
  const r = D.settlePayment(o.id, { paymentRef: pay.id, fee: pay.attributes.fee || 0 });
  if (r.needsRefund) {
    try { await PM.refund(pay.id, o.total); D.noteOrder(o.id, `Paid after tickets sold out — automatically refunded (${pay.id})`); }
    catch (e) { console.error('Auto-refund failed for', o.ref, e.message); }
  }
  return r.ok;
}

// PayMongo calls this the moment a resident's payment succeeds. Needs the raw body to verify the signature.
app.post('/webhooks/paymongo', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!PM.verifyWebhook(req.body, req.get('Paymongo-Signature'))) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8')).data?.attributes;
  if (event?.type === 'checkout_session.payment.paid') {
    const order = D.orderByGateway(event.data.id);
    if (order) await settleFromSession(order.id, event.data);
    else console.error('Webhook for unknown checkout session', event.data.id);
  }
  res.sendStatus(200);
});

app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use((req, res, next) => { req.body ??= {}; next(); });   // POSTs without a body
app.use(express.static(path.join(__dirname, 'public')));

const flashOf = (req) => req.query.err ? { type: 'error', text: req.query.err }
  : req.query.msg ? { type: 'ok', text: req.query.msg } : null;
const withMsg = (url, key, text) => url + (url.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(text);
const stripFlash = (url) => { const u = new URL(url, 'http://x'); u.searchParams.delete('msg'); u.searchParams.delete('err'); return u.pathname + u.search; };
const wantsJson = (req) => req.get('X-Requested-With') === 'fetch';
const clean = (s, max = 120) => String(s ?? '').trim().slice(0, max);
const toCentavos = (s) => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100);

// Automation: release tickets held by unpaid orders once their payment window lapses.
// Before releasing, any checkout page still open at PayMongo is checked one last time and then closed.
async function housekeeping() {
  if (PM.enabled()) for (const { id } of D.staleGatewayOrders()) {
    try {
      const o = D.orderDetail('id', id);
      if (!(await settleFromSession(id, await PM.getCheckout(o.gateway_id)))) await PM.expireCheckout(o.gateway_id).catch(() => {});
      D.closeGateway(id);
    } catch (e) { console.error('Housekeeping failed for order', id, e.message); }
  }
  D.expireOrders();
}
setInterval(() => housekeeping().catch(console.error), 60e3).unref();
housekeeping().catch(console.error);

// =====================================================================
// RESIDENT SITE
// =====================================================================
function eventCard(ev) {
  const types = D.ticketTypes(ev.id);
  const from = types.length ? Math.min(...types.map((t) => t.price)) : 0;
  const left = types.reduce((s, t) => s + t.available, 0);
  return `<div class="card"><h2>${esc(ev.name)}</h2>
    <p class="sub">${esc(fmtEventDate(ev.event_date))} · ${esc(ev.venue)}</p>
    <p>${esc(ev.description)}</p>
    <p><strong>From ${peso(from)}</strong> · ${left ? `${left} tickets left` : 'Sold out'}</p>
    <a class="btn" href="/event/${ev.id}">${left ? 'Buy tickets' : 'View event'}</a></div>`;
}

app.get('/', (req, res) => {
  const events = D.listEvents(true);
  if (events.length === 1) return res.redirect('/event/' + events[0].id);
  res.send(page('Concert tickets', `<h1>Upcoming concerts</h1><p class="sub">Buy your tickets online — no need to line up.</p>
    ${events.map(eventCard).join('') || '<div class="card">No concerts are on sale right now. Please check back soon.</div>'}`,
    { flash: flashOf(req) }));
});

app.get('/event/:id', (req, res) => {
  const ev = D.getEvent(req.params.id);
  if (!ev) return res.status(404).send(page('Not found', '<h1>Event not found</h1>'));
  D.expireOrders();
  const types = D.ticketTypes(ev.id);
  const tiers = types.map((t) => {
    const max = Math.min(D.MAX_PER_ORDER, t.available);
    const opts = Array.from({ length: max + 1 }, (_, n) => `<option>${n}</option>`).join('');
    return `<div class="tier ${t.available ? '' : 'soldout'}">
      <div class="info"><div class="name">${esc(t.name)}</div>
        <div class="left">${t.available ? (t.available <= 20 ? `Only ${t.available} left!` : `${t.available} available`) : 'Sold out'}</div></div>
      <div class="price">${peso(t.price)}</div>
      <select name="qty_${t.id}" data-price="${t.price}" aria-label="Quantity for ${esc(t.name)}" ${t.available ? '' : 'disabled'}>${opts}</select></div>`;
  }).join('');
  const body = `<h1>${esc(ev.name)}</h1>
    <p class="sub">${esc(fmtEventDate(ev.event_date))} · ${esc(ev.venue)}</p>
    <p>${esc(ev.description)}</p>
    ${ev.on_sale ? `<form class="wizard card" method="post" action="/event/${ev.id}/order" data-max="${D.MAX_PER_ORDER}">
      <div class="steps" aria-hidden="true"><i class="ln"><b></b></i>
        <button type="button" class="st on" data-go="0" tabindex="-1"><u>1</u>Tickets</button>
        <button type="button" class="st" data-go="1" tabindex="-1"><u>2</u>Your details</button>
        <button type="button" class="st" data-go="2" tabindex="-1"><u>3</u>Review &amp; pay</button></div>
      <div class="vp"><div class="tr">
        <section class="pg" aria-label="Step 1 of 3: Choose your tickets"><h2>Choose your tickets</h2>${tiers}
          <p class="tot">Total: <strong data-total>${peso(0)}</strong><br><small class="sub">Maximum ${D.MAX_PER_ORDER} tickets per order</small></p></section>
        <section class="pg" aria-label="Step 2 of 3: Your details"><h2>Your details</h2>
          <div class="row">
            <div><label for="n">Full name</label><input id="n" name="buyer_name" required maxlength="80" autocomplete="name"></div>
            <div><label for="m">Mobile number</label><input id="m" name="mobile" required inputmode="numeric" maxlength="16" pattern="09[0-9]{9}" placeholder="09XXXXXXXXX" title="11-digit mobile number starting with 09"></div>
          </div>
          <label for="a">Purok / Street address in the barangay</label><input id="a" name="address" required maxlength="120"></section>
        <section class="pg" aria-label="Step 3 of 3: Review and pay"><h2>Review &amp; pay</h2>
          <div class="review" data-review></div>
          <h2>How will you pay?</h2>
          ${onlineAvailable() ? `<label class="radio"><input type="radio" name="payment_method" value="online" checked>
            <span><strong>Pay online now</strong><small>GCash / e-wallet. Tickets are issued instantly. Finish payment within ${D.ONLINE_HOLD_MIN} minutes.</small></span></label>` : ''}
          <label class="radio"><input type="radio" name="payment_method" value="cash" ${onlineAvailable() ? '' : 'checked'}>
            <span><strong>Pay cash at the Barangay Hall</strong><small>We hold your tickets for ${D.CASH_HOLD_HOURS} hours. Bring your order number to the treasurer.</small></span></label></section>
      </div></div>
      <p class="werr" role="alert"></p>
      <div class="ft"><button type="button" class="btn ghost bk">Back</button>
        <button type="button" class="btn nx">Next</button>
        <span class="gw"><button type="submit" class="btn go" data-s="idle"><i class="g"></i><span class="lab">Place order</span>
          <span class="dots" aria-hidden="true"><b></b><b></b><b></b></span>
          <svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button></span></div>
      <p class="vh" aria-live="polite"></p></form>
      <script src="/wizard.js" defer></script>` : '<div class="notice">Ticket sales for this event are closed.</div>'}`;
  res.send(page(ev.name, body, { flash: flashOf(req) }));
});

app.post('/event/:id/order', (req, res) => {
  const b = req.body, back = '/event/' + req.params.id;
  const buyerName = clean(b.buyer_name, 80), mobile = clean(b.mobile, 20).replace(/\D/g, ''), address = clean(b.address);
  if (!buyerName || !address) throw new D.UserError('Please fill in your name and address.');
  if (!/^09\d{9}$/.test(mobile)) throw new D.UserError('Enter an 11-digit mobile number starting with 09.');
  const quantities = {};
  for (const [k, v] of Object.entries(b)) {
    const m = /^qty_(\d+)$/.exec(k), n = parseInt(v, 10);
    if (m && n > 0 && n <= D.MAX_PER_ORDER) quantities[m[1]] = n;
  }
  const paymentMethod = b.payment_method === 'online' && onlineAvailable() ? 'online' : 'cash';
  const token = D.createOrder({ eventId: req.params.id, buyerName, mobile, address, paymentMethod, quantities });
  const next = paymentMethod === 'online' ? '/pay/' + token : '/order/' + token;
  // The step-by-step form sends the order in the background (to play its button animation) and wants JSON back.
  if (wantsJson(req)) return res.json({ redirect: next });
  res.redirect(next);
});

// ---------- online payment ----------
// DEMO GATEWAY: stands in for a real provider (e.g. PayMongo / Xendit for GCash & Maya).
// A real integration replaces these two routes: GET redirects to the provider's checkout page,
// and the provider's webhook calls D.markPaid(order.id, { paymentRef }) — everything after that is unchanged.
app.get('/pay/:token', async (req, res) => {
  D.expireOrders();
  const o = D.orderDetail('token', req.params.token);
  if (!o) return res.status(404).send(page('Not found', '<h1>Order not found</h1>'));
  if (o.status !== 'pending' || o.payment_method !== 'online' || !onlineAvailable()) return res.redirect('/order/' + o.token);
  if (PM.enabled()) {
    if (o.gateway_url) return res.redirect(o.gateway_url);
    const session = await PM.createCheckout(o, baseUrl(req));
    D.setGateway(o.id, session.id, session.attributes.checkout_url);
    return res.redirect(session.attributes.checkout_url);
  }
  res.send(page('Pay for order ' + o.ref, `<h1>Pay ${peso(o.total)}</h1>
    <p class="sub">Order ${esc(o.ref)} · ${esc(o.event_name)} · pay before ${esc(fmtDateTime(o.expires_at))}</p>
    <div class="demo"><strong>Demo payment page</strong>
      <p>This screen stands in for the GCash / e-wallet checkout. No real money moves. Once a payment provider account is connected, residents will see the provider's page here instead.</p>
      <form method="post" action="/pay/${o.token}"><button class="btn">Simulate successful payment</button>
      <a class="btn ghost" href="/order/${o.token}">Pay later</a></form></div>`));
});

app.post('/pay/:token', (req, res) => {
  const o = D.orderDetail('token', req.params.token);
  if (!o) return res.status(404).send(page('Not found', '<h1>Order not found</h1>'));
  if (PM.enabled() || !DEMO_OK) return res.sendStatus(404);            // demo button: local test copies only
  if (o.payment_method !== 'online') throw new D.UserError('This order is to be paid in cash at the Barangay Hall.');
  D.markPaid(o.id, { paymentRef: 'DEMO-' + Date.now() });
  res.redirect(withMsg('/order/' + o.token, 'msg', 'Payment received. Your tickets are ready!'));
});

// PayMongo sends the resident back here after paying. We confirm with PayMongo directly rather than trusting the redirect.
app.get('/pay/:token/return', async (req, res) => {
  const o = D.orderDetail('token', req.params.token);
  if (!o) return res.status(404).send(page('Not found', '<h1>Order not found</h1>'));
  if (o.status !== 'paid' && PM.enabled() && o.gateway_id) await settleFromSession(o.id, await PM.getCheckout(o.gateway_id));
  const paid = D.orderDetail('id', o.id).status === 'paid';
  res.redirect(withMsg('/order/' + o.token, paid ? 'msg' : 'err', paid ? 'Payment received. Your tickets are ready!'
    : 'We have not received your payment confirmation yet. Refresh this page in a minute.'));
});

// ---------- order + e-tickets ----------
app.get('/order/:token', async (req, res) => {
  let o = D.orderDetail('token', req.params.token);
  if (!o) return res.status(404).send(page('Not found', '<h1>Order not found</h1>'));
  // Covers a missed webhook: if the resident already paid, pick it up when they open their order.
  if (o.status === 'pending' && o.gateway_open && PM.enabled()) {
    try { await settleFromSession(o.id, await PM.getCheckout(o.gateway_id)); } catch { /* provider unreachable: show current status */ }
  }
  D.expireOrders();
  o = D.orderDetail('token', req.params.token);
  const base = baseUrl(req);
  let status = '';
  if (o.status === 'pending' && o.payment_method === 'cash')
    status = `<div class="notice"><strong>Your tickets are reserved.</strong> Pay <strong>${peso(o.total)}</strong> in cash at the Barangay Hall treasurer
      before <strong>${esc(fmtDateTime(o.expires_at))}</strong> and give order number <strong>${esc(o.ref)}</strong>.
      Your e-tickets will appear on this page as soon as payment is recorded. Unpaid orders are released automatically.</div>`;
  else if (o.status === 'pending')
    status = `<div class="notice">Payment not yet completed. Tickets are held until ${esc(fmtDateTime(o.expires_at))}.
      <p><a class="btn" href="/pay/${o.token}">Pay now</a></p></div>`;
  else if (o.status === 'cancelled') status = `<div class="notice">This order was cancelled (${esc(o.note || 'unpaid')}). You may place a new order.</div>`;
  else if (o.status === 'refunded') status = `<div class="notice">This order was refunded and its tickets are no longer valid.</div>`;

  const tickets = await Promise.all(o.tickets.map(async (t, i) => {
    const qr = await QRCode.toDataURL(`${base}/admin/checkin?code=${t.code}`, { margin: 1, width: 264 });
    return `<div class="ticket ${t.status}"><img src="${qr}" alt="QR code for ticket ${esc(t.code)}">
      <div><div><strong>${esc(o.event_name)}</strong></div><div>${esc(t.name)}</div>
      <div class="sub" style="margin:0">${esc(fmtEventDate(o.event_date))} · ${esc(o.venue)}</div>
      <div class="code">${esc(t.code)}</div><div>Ticket ${i + 1} of ${o.tickets.length} · ${esc(o.buyer_name)} ${badge(t.status)}</div></div></div>`;
  }));
  res.send(page('Order ' + o.ref, `<h1>Order ${esc(o.ref)} ${badge(o.status)}</h1>
    <p class="sub">Save or screenshot this page — it is your receipt and your tickets.</p>${status}
    <div class="card"><table>
      <tr><th>Ticket</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr>
      ${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${peso(i.unit_price)}</td><td class="num">${peso(i.qty * i.unit_price)}</td></tr>`).join('')}
      <tr class="total"><td colspan="3">Total</td><td class="num">${peso(o.total)}</td></tr></table>
      <p class="sub" style="margin:12px 0 0">${esc(o.buyer_name)} · ${esc(o.mobile)} · ${esc(METHOD[o.payment_method])}
        ${o.paid_at ? ' · Paid ' + esc(fmtDateTime(o.paid_at)) : ''}</p></div>
    ${tickets.length ? `<h2>Your tickets</h2><p class="sub">Show each QR code at the gate. One QR = one person.</p>${tickets.join('')}
      <button class="btn ghost noprint" onclick="print()">Print tickets</button>` : ''}`, { flash: flashOf(req) }));
});

app.get('/find', (req, res) => res.send(page('Find my tickets', `<h1>Find my tickets</h1>
  <p class="sub">Enter your order number and the mobile number you used.</p>
  <form class="card" method="post" action="/find" style="max-width:420px">
    <label for="r">Order number</label><input id="r" name="ref" required placeholder="BC-XXXXXX">
    <label for="m">Mobile number</label><input id="m" name="mobile" required inputmode="numeric" placeholder="09XXXXXXXXX">
    <p><button class="btn">Find order</button></p></form>`, { flash: flashOf(req) })));

app.post('/find', (req, res) => {
  const o = D.findOrder(clean(req.body.ref, 12).toUpperCase(), clean(req.body.mobile, 11));
  res.redirect(o ? '/order/' + o.token : withMsg('/find', 'err', 'No order matches that order number and mobile number.'));
});

// =====================================================================
// ADMIN
// =====================================================================
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];

app.get('/admin/login', (req, res) => res.send(page('Admin login', `<h1>Admin login</h1>
  <form class="card" method="post" action="/admin/login" style="max-width:380px">
    <input type="hidden" name="next" value="${esc(req.query.next || '')}">
    <label for="u">Username</label><input id="u" name="username" required autocomplete="username">
    <label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password">
    <p><button class="btn">Log in</button></p></form>`, { admin: true, flash: flashOf(req) })));

// Slows down password guessing: 10 wrong attempts from one address locks it out for 15 minutes.
const failedLogins = new Map();
app.post('/admin/login', (req, res) => {
  const ip = req.ip, f = failedLogins.get(ip);
  if (f && f.count >= 10 && Date.now() - f.since < 15 * 60e3)
    return res.redirect(withMsg('/admin/login', 'err', 'Too many wrong attempts. Try again in 15 minutes.'));
  const user = D.checkLogin(req.body.username, req.body.password);
  if (!user) {
    const cur = f && Date.now() - f.since < 15 * 60e3 ? f : { count: 0, since: Date.now() };
    cur.count++; failedLogins.set(ip, cur);
    if (failedLogins.size > 10000) failedLogins.clear();
    return res.redirect(withMsg('/admin/login', 'err', 'Wrong username or password.'));
  }
  failedLogins.delete(ip);
  res.setHeader('Set-Cookie', `sid=${D.createSession(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${HTTPS ? '; Secure' : ''}`);
  const next = String(req.body.next || '');
  res.redirect(next.startsWith('/admin') ? next : '/admin');
});

app.use('/admin', (req, res, next) => {
  req.user = D.sessionUser(cookieOf(req, 'sid'));
  if (!req.user) return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
  next();
});

app.post('/admin/logout', (req, res) => {
  D.destroySession(cookieOf(req, 'sid'));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

// Every admin page works on one selected event (?event=ID, defaulting to the first).
function pickEvent(req) {
  const events = D.listEvents(false);
  const ev = events.find((e) => e.id == req.query.event) || events[0];
  const picker = events.length > 1 ? `<form class="toolbar noprint"><select name="event" onchange="this.form.submit()">
    ${events.map((e) => `<option value="${e.id}" ${e.id === ev.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></form>` : '';
  return { ev, picker };
}
const adminPage = (req, title, body, ev) => page(title, body, { admin: true, user: req.user, eventId: ev?.id, flash: flashOf(req) });
const backTo = (req, fallback) => { const r = String(req.body.back || ''); return r.startsWith('/admin') ? r : fallback; };

app.get('/admin', (req, res) => {
  const { ev, picker } = pickEvent(req);
  if (!ev) return res.redirect('/admin/events');
  const f = D.financeReport(ev.id);
  const recent = D.listOrders(ev.id).slice(0, 8);
  res.send(adminPage(req, 'Dashboard', `<h1>${esc(ev.name)}</h1>
    <p class="sub">${esc(fmtEventDate(ev.event_date))} · ${esc(ev.venue)} · ${ev.on_sale ? 'On sale' : 'Sales closed'}</p>${picker}
    ${!PM.enabled() && !DEMO_OK ? '<div class="notice"><strong>Online payment is switched off</strong> — residents can only reserve and pay cash until the PayMongo keys are added in the hosting settings (see HOSTING.md).</div>' : ''}${{ demo: !DEMO_OK ? '' : '<div class="notice"><strong>Online payments are in demo mode.</strong> No real money is collected. Add your PayMongo keys to the <code>.env</code> file to go live (see README).</div>', test: '<div class="notice"><strong>PayMongo is connected in TEST mode.</strong> Payments are simulated by PayMongo; switch to your live secret key to collect real money.</div>', live: '' }[PM.mode()]}
    <div class="kpis">
      <div class="kpi"><div class="v">${peso(f.netSales)}</div><div class="l">Net ticket sales</div></div>
      <div class="kpi"><div class="v">${f.ticketsSold} / ${f.capacity}</div><div class="l">Tickets sold</div></div>
      <div class="kpi"><div class="v">${peso(f.expenses)}</div><div class="l">Expenses</div></div>
      <div class="kpi"><div class="v ${f.netIncome < 0 ? 'neg' : ''}">${peso(f.netIncome)}</div><div class="l">Net income</div></div>
      <div class="kpi"><div class="v">${f.pending.n}</div><div class="l">Unpaid orders (${peso(f.pending.amt)})</div></div>
      <div class="kpi"><div class="v">${f.gate.used} / ${f.gate.issued}</div><div class="l">Checked in at gate</div></div>
    </div>
    <div class="card"><h2>Sales by ticket type</h2><div class="scroll"><table>
      <tr><th>Type</th><th class="num">Price</th><th class="num">Sold</th><th class="num">Held (unpaid)</th><th class="num">Left</th><th>Sold %</th><th class="num">Revenue</th></tr>
      ${f.types.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${peso(t.price)}</td><td class="num">${t.sold}</td><td class="num">${t.held}</td>
        <td class="num">${t.available}</td><td><div class="meter" title="${t.sold} of ${t.capacity}"><i style="width:${t.capacity ? (100 * t.sold / t.capacity).toFixed(1) : 0}%"></i></div></td>
        <td class="num">${peso(t.revenue)}</td></tr>`).join('')}</table></div></div>
    <div class="card"><h2>Recent orders</h2>${ordersTable(recent, req.originalUrl)}
      <p><a href="/admin/orders?event=${ev.id}">All orders →</a></p></div>`, ev));
});

function ordersTable(orders, back) {
  if (!orders.length) return '<p class="sub">No orders yet.</p>';
  const act = (o, action, label, confirmText) => `<form method="post" action="/admin/orders/${o.id}/${action}" class="inline"
    ${confirmText ? `onsubmit="return confirm('${confirmText}')"` : ''}><input type="hidden" name="back" value="${esc(back)}">
    <button class="btn small ${action === 'paid' ? '' : 'ghost'}">${label}</button></form>`;
  return `<div class="scroll"><table><tr><th>Order</th><th>Buyer</th><th class="num">Qty</th><th class="num">Total</th><th>Payment</th><th>Status</th><th>Placed</th><th></th></tr>
    ${orders.map((o) => `<tr><td><a href="/order/${o.token}" target="_blank">${esc(o.ref)}</a></td>
      <td>${esc(o.buyer_name)}<br><small class="sub">${esc(o.mobile)} · ${esc(o.address)}</small></td>
      <td class="num">${o.qty}</td><td class="num">${peso(o.total)}</td>
      <td>${o.payment_method === 'cash' ? 'Cash' : 'Online'}${o.received_by ? `<br><small class="sub">rcvd by ${esc(o.received_by)}</small>` : ''}</td>
      <td>${badge(o.status)}${o.note ? `<br><small class="sub">${esc(o.note)}</small>` : ''}</td><td>${esc(fmtDateTime(o.created_at))}</td>
      <td><div class="actions">${o.status === 'pending' ? (o.payment_method === 'cash' ? act(o, 'paid', 'Receive cash', `Confirm you received ${peso(o.total)} in cash for ${o.ref}?`) : '') + act(o, 'cancel', 'Cancel', `Cancel order ${o.ref}?`)
        : o.status === 'paid' ? act(o, 'refund', 'Refund', `Refund ${peso(o.total)} for ${o.ref}? Its tickets will be voided.`) : ''}</div></td></tr>`).join('')}</table></div>`;
}

app.get('/admin/orders', (req, res) => {
  const { ev, picker } = pickEvent(req);
  if (!ev) return res.redirect('/admin/events');
  D.expireOrders();
  const status = ['pending', 'paid', 'cancelled', 'refunded'].includes(req.query.status) ? req.query.status : '';
  const search = clean(req.query.q, 40);
  const orders = D.listOrders(ev.id, { status, search });
  res.send(adminPage(req, 'Orders', `<h1>Orders</h1><p class="sub">${esc(ev.name)}</p>${picker}
    <form class="toolbar"><input type="hidden" name="event" value="${ev.id}">
      <input class="grow" name="q" value="${esc(search)}" placeholder="Search order no., name or mobile">
      <select name="status"><option value="">All statuses</option>${['pending', 'paid', 'cancelled', 'refunded'].map((s) =>
        `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="btn">Filter</button>
      <a class="btn ghost" href="/admin/export/orders.csv?event=${ev.id}">Export CSV</a>
      <a class="btn ghost" href="/event/${ev.id}" target="_blank">+ Walk-in sale</a></form>
    <div class="card">${ordersTable(orders, req.originalUrl)}</div>`, ev));
});

app.post('/admin/orders/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  let msg;
  const o = D.orderDetail('id', id);
  if (!o) return res.sendStatus(404);
  if (action === 'paid') { D.markPaid(id, { receivedBy: req.user }); msg = 'Cash received — tickets issued.'; }
  else if (action === 'cancel') {
    // Make sure the resident has not just paid, then close the PayMongo checkout page so they cannot pay a cancelled order.
    if (o.gateway_open && PM.enabled()) {
      if (await settleFromSession(o.id, await PM.getCheckout(o.gateway_id))) throw new D.UserError('This order was just paid online — it can no longer be cancelled.');
      await PM.expireCheckout(o.gateway_id).catch(() => {});
      D.closeGateway(o.id);
    }
    D.cancelOrder(id, req.user); msg = 'Order cancelled and tickets released.';
  }
  else if (action === 'refund') {
    D.assertRefundable(id);
    const viaGateway = PM.enabled() && /^pay_/.test(o.payment_ref || '');
    if (viaGateway) await PM.refund(o.payment_ref, o.total);          // money goes back to the resident's GCash / wallet
    D.refundOrder(id, req.user);
    msg = viaGateway ? 'Refund sent through PayMongo and tickets voided.' : 'Order marked refunded and tickets voided. Return the money to the buyer by hand.';
  }
  else return res.sendStatus(404);
  res.redirect(withMsg(stripFlash(backTo(req, '/admin/orders')), 'msg', msg));
});

// ---------- gate check-in ----------
// Each ticket QR opens /admin/checkin?code=XXXX, so gate staff logged in on a phone just scan with the camera.
const checkinPage = (req, result, code = '') => adminPage(req, 'Gate check-in', `<h1>Gate check-in</h1>
  ${result ? `<div class="result ${result.ok ? 'ok' : 'bad'}">${result.ok ? '✓' : '✕'} ${esc(result.message)}
    ${result.ticket ? `<small>${esc(result.ticket.type_name)} · ${esc(result.ticket.buyer_name)} · ${esc(result.ticket.code)}
      ${!result.ok && result.ticket.checked_in_at ? '<br>Entered ' + esc(fmtDateTime(result.ticket.checked_in_at)) + ' (by ' + esc(result.ticket.checked_in_by) + ')' : ''}</small>` : ''}</div>` : ''}
  <form class="card" method="post" action="/admin/checkin" id="f" style="max-width:460px">
    <label for="c">Ticket code</label><input id="c" name="code" value="${esc(code)}" required autofocus autocapitalize="characters" autocomplete="off" style="font:700 20px ui-monospace,Consolas,monospace;letter-spacing:.08em">
    <p><button class="btn block">Check in</button></p>
    <p class="sub">Tip: scan the ticket's QR code with this phone's camera while logged in — it opens this page and checks the ticket in.</p></form>
  ${code ? '<script>document.getElementById("f").submit()</script>' : ''}`);

app.get('/admin/checkin', (req, res) => res.send(checkinPage(req, null, clean(req.query.code, 20))));
app.post('/admin/checkin', (req, res) =>
  res.send(checkinPage(req, D.checkIn(clean(req.body.code, 20).toUpperCase().replace(/\s/g, ''), req.user))));

// ---------- expenses ----------
const CATEGORIES = ['Talent / performers', 'Sound & lights', 'Stage & venue', 'Security & marshals', 'Permits & fees', 'Marketing & printing', 'Food & refreshments', 'Other'];

app.get('/admin/expenses', (req, res) => {
  const { ev, picker } = pickEvent(req);
  if (!ev) return res.redirect('/admin/events');
  const list = D.listExpenses(ev.id);
  res.send(adminPage(req, 'Expenses', `<h1>Expenses</h1><p class="sub">${esc(ev.name)} — recorded here, deducted automatically in the financial report.</p>${picker}
    <form class="card" method="post" action="/admin/expenses"><input type="hidden" name="event" value="${ev.id}"><h2>Add expense</h2>
      <div class="row">
        <div><label>Date</label><input type="date" name="spent_on" required value="${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)}"></div>
        <div><label>Category</label><select name="category">${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div><label>Amount (₱)</label><input name="amount" required inputmode="decimal" placeholder="0.00"></div>
      </div>
      <label>Description / payee</label><input name="description" required maxlength="160">
      <p><button class="btn">Save expense</button></p></form>
    <div class="card">${list.length ? `<div class="scroll"><table><tr><th>Date</th><th>Category</th><th>Description</th><th>By</th><th class="num">Amount</th><th></th></tr>
      ${list.map((e) => `<tr><td>${esc(e.spent_on)}</td><td>${esc(e.category)}</td><td>${esc(e.description)}</td><td>${esc(e.recorded_by)}</td><td class="num">${peso(e.amount)}</td>
        <td><form method="post" action="/admin/expenses/${e.id}/delete" onsubmit="return confirm('Delete this expense?')"><input type="hidden" name="event" value="${ev.id}"><button class="btn small ghost">Delete</button></form></td></tr>`).join('')}
      <tr class="total"><td colspan="4">Total</td><td class="num">${peso(list.reduce((s, e) => s + e.amount, 0))}</td><td></td></tr></table></div>` : '<p class="sub">No expenses recorded yet.</p>'}</div>`, ev));
});

app.post('/admin/expenses', (req, res) => {
  const b = req.body, back = '/admin/expenses?event=' + parseInt(b.event, 10);
  const amount = toCentavos(b.amount);
  if (!D.getEvent(b.event)) throw new D.UserError('Event not found.');
  if (!(amount > 0)) return res.redirect(withMsg(back, 'err', 'Enter a valid amount.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.spent_on)) return res.redirect(withMsg(back, 'err', 'Enter a valid date.'));
  D.addExpense({ eventId: b.event, spentOn: b.spent_on, category: CATEGORIES.includes(b.category) ? b.category : 'Other',
    description: clean(b.description, 160), amount, by: req.user });
  res.redirect(withMsg(back, 'msg', 'Expense saved.'));
});

app.post('/admin/expenses/:id/delete', (req, res) => {
  D.deleteExpense(req.params.id);
  res.redirect(withMsg('/admin/expenses?event=' + parseInt(req.body.event, 10), 'msg', 'Expense deleted.'));
});

// ---------- financial report ----------
app.get('/admin/report', (req, res) => {
  const { ev, picker } = pickEvent(req);
  if (!ev) return res.redirect('/admin/events');
  const f = D.financeReport(ev.id);
  const line = (label, amt, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${peso(amt)}</td></tr>`;
  res.send(adminPage(req, 'Financial report', `<h1>Financial report</h1>
    <p class="sub">${esc(ev.name)} · ${esc(fmtEventDate(ev.event_date))} · generated ${esc(fmtDateTime(D.now()))}</p>${picker}
    <div class="toolbar noprint"><button class="btn" onclick="print()">Print / save as PDF</button>
      <a class="btn ghost" href="/admin/export/report.csv?event=${ev.id}">Download report (CSV)</a>
      <a class="btn ghost" href="/admin/export/orders.csv?event=${ev.id}">Download all orders (CSV)</a></div>
    <div class="card"><h2>Income statement</h2><table>
      ${line(`Gross ticket sales (${f.paidOrders + f.refundCount} orders)`, f.grossSales)}
      ${line(`Less: refunds (${f.refundCount})`, -f.refunds)}
      ${line('Net ticket sales', f.netSales, 'total')}
      ${f.expByCat.map((e) => line('&nbsp;&nbsp;' + esc(e.category), -e.amt)).join('')}
      ${f.gatewayFees ? line('&nbsp;&nbsp;Online payment processing fees (PayMongo)', -f.gatewayFees) : ''}
      ${line('Total expenses', -(f.expenses + f.gatewayFees), 'total')}
      ${line('NET INCOME', f.netIncome, 'total')}</table>
      ${f.pending.n ? `<p class="sub" style="margin:12px 0 0">Not included: ${f.pending.n} unpaid order(s) worth ${peso(f.pending.amt)} still awaiting payment.</p>` : ''}</div>
    <div class="card"><h2>Sales by ticket type</h2><table><tr><th>Type</th><th class="num">Price</th><th class="num">Capacity</th><th class="num">Sold</th><th class="num">Revenue</th></tr>
      ${f.types.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${peso(t.price)}</td><td class="num">${t.capacity}</td><td class="num">${t.sold}</td><td class="num">${peso(t.revenue)}</td></tr>`).join('')}
      <tr class="total"><td colspan="2">Total</td><td class="num">${f.capacity}</td><td class="num">${f.ticketsSold}</td><td class="num">${peso(f.netSales)}</td></tr></table></div>
    <div class="card"><h2>Collections by payment method</h2><table><tr><th>Method</th><th class="num">Orders</th><th class="num">Amount</th></tr>
      ${f.byMethod.map((m) => `<tr><td>${esc(METHOD[m.payment_method])}</td><td class="num">${m.n}</td><td class="num">${peso(m.amt)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">No payments yet.</td></tr>'}</table>
      ${f.cashByStaff.length ? `<h2>Cash to be remitted, by staff who received it</h2><table><tr><th>Staff</th><th class="num">Orders</th><th class="num">Cash received</th></tr>
        ${f.cashByStaff.map((s) => `<tr><td>${esc(s.staff)}</td><td class="num">${s.n}</td><td class="num">${peso(s.amt)}</td></tr>`).join('')}</table>` : ''}</div>
    <div class="card"><h2>Daily sales</h2><table><tr><th>Date</th><th class="num">Orders</th><th class="num">Tickets</th><th class="num">Amount</th></tr>
      ${f.daily.map((d) => `<tr><td>${d.date}</td><td class="num">${d.orders}</td><td class="num">${d.tickets}</td><td class="num">${peso(d.amt)}</td></tr>`).join('') || '<tr><td colspan="4" class="sub">No sales yet.</td></tr>'}</table></div>
    <div class="card"><h2>Attendance</h2><p>${f.gate.used} of ${f.gate.issued} issued tickets checked in at the gate.</p></div>`, ev));
});

const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
const sendCsv = (res, name, rows) => res.type('text/csv').attachment(name).send(csv(rows));
const amt = (c) => (c / 100).toFixed(2);

app.get('/admin/export/orders.csv', (req, res) => {
  const { ev } = pickEvent(req);
  const rows = D.q(`SELECT o.*, (SELECT GROUP_CONCAT(i.qty || ' x ' || t.name, '; ') FROM order_items i
      JOIN ticket_types t ON t.id = i.ticket_type_id WHERE i.order_id = o.id) AS items
    FROM orders o WHERE o.event_id = ? ORDER BY o.id`).all(ev.id);
  sendCsv(res, `orders-event-${ev.id}.csv`, [
    ['Order no', 'Status', 'Buyer', 'Mobile', 'Address', 'Tickets', 'Total (PHP)', 'Payment method', 'Payment ref', 'Gateway fee (PHP)', 'Received by', 'Placed', 'Paid', 'Note'],
    ...rows.map((o) => [o.ref, o.status, o.buyer_name, o.mobile, o.address, o.items, amt(o.total), o.payment_method, o.payment_ref, amt(o.gateway_fee), o.received_by, fmtDateTime(o.created_at), fmtDateTime(o.paid_at), o.note])]);
});

app.get('/admin/export/report.csv', (req, res) => {
  const { ev } = pickEvent(req);
  const f = D.financeReport(ev.id);
  sendCsv(res, `financial-report-event-${ev.id}.csv`, [
    ['Financial report', ev.name], ['Generated', fmtDateTime(D.now())], [],
    ['INCOME STATEMENT', 'PHP'], ['Gross ticket sales', amt(f.grossSales)], ['Less: refunds', amt(-f.refunds)], ['Net ticket sales', amt(f.netSales)],
    ...f.expByCat.map((e) => ['Expense: ' + e.category, amt(-e.amt)]), ['Expense: Online payment processing fees (PayMongo)', amt(-f.gatewayFees)], ['Total expenses', amt(-(f.expenses + f.gatewayFees))], ['NET INCOME', amt(f.netIncome)], [],
    ['SALES BY TICKET TYPE', 'Price', 'Capacity', 'Sold', 'Revenue'], ...f.types.map((t) => [t.name, amt(t.price), t.capacity, t.sold, amt(t.revenue)]), [],
    ['COLLECTIONS BY METHOD', 'Orders', 'Amount'], ...f.byMethod.map((m) => [METHOD[m.payment_method], m.n, amt(m.amt)]), [],
    ['CASH RECEIVED BY STAFF', 'Orders', 'Amount'], ...f.cashByStaff.map((s) => [s.staff, s.n, amt(s.amt)]), [],
    ['DAILY SALES', 'Orders', 'Tickets', 'Amount'], ...f.daily.map((d) => [d.date, d.orders, d.tickets, amt(d.amt)]), [],
    ['Tickets checked in', f.gate.used, 'of', f.gate.issued]]);
});

// ---------- events & ticket types ----------
const eventFields = (e = {}) => `<div class="row">
    <div><label>Concert name</label><input name="name" required maxlength="100" value="${esc(e.name)}"></div>
    <div><label>Date & time</label><input type="datetime-local" name="event_date" required value="${esc(e.event_date)}"></div>
    <div><label>Venue</label><input name="venue" required maxlength="100" value="${esc(e.venue)}"></div></div>
  <label>Description</label><textarea name="description" rows="2" maxlength="500">${esc(e.description)}</textarea>`;
const typeFields = (t = {}) => `<input name="name" required maxlength="60" placeholder="Ticket type name" value="${esc(t.name)}" class="grow">
  <input name="price" required inputmode="decimal" placeholder="Price ₱" value="${t.price != null ? amt(t.price) : ''}" style="width:110px">
  <input name="capacity" required inputmode="numeric" placeholder="Capacity" value="${esc(t.capacity)}" style="width:100px">`;

app.get('/admin/events', (req, res) => {
  const events = D.listEvents(false);
  res.send(adminPage(req, 'Events', `<h1>Events & ticket types</h1>
    ${events.map((e) => `<div class="card"><h2>${esc(e.name)} ${badge(e.on_sale ? 'paid' : 'cancelled').replace(/>[a-z]+</, `>${e.on_sale ? 'on sale' : 'sales closed'}<`)}</h2>
      <form method="post" action="/admin/events/${e.id}">${eventFields(e)}
        <label class="radio" style="border:0;padding:8px 0"><input type="checkbox" name="on_sale" ${e.on_sale ? 'checked' : ''}><span>Tickets on sale to residents</span></label>
        <button class="btn small">Save event</button> <a class="btn small ghost" href="/event/${e.id}" target="_blank">View public page</a></form>
      <h2>Ticket types</h2>
      ${D.ticketTypes(e.id).map((t) => `<form class="toolbar" method="post" action="/admin/types/${t.id}">${typeFields(t)}
        <button class="btn small ghost">Save</button><span class="sub">${t.sold} sold</span></form>`).join('')}
      <form class="toolbar" method="post" action="/admin/events/${e.id}/types">${typeFields()}<button class="btn small">Add type</button></form></div>`).join('')}
    <div class="card"><h2>Create a new concert</h2><form method="post" action="/admin/events">${eventFields()}<p><button class="btn">Create event</button></p></form></div>`));
});

function readEvent(b) {
  const e = { name: clean(b.name, 100), event_date: clean(b.event_date, 16), venue: clean(b.venue, 100), description: clean(b.description, 500) };
  if (!e.name || !e.venue || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.event_date)) throw new D.UserError('Please complete the event name, date and venue.');
  return e;
}
function readType(b) {
  const t = { name: clean(b.name, 60), price: toCentavos(b.price), capacity: parseInt(b.capacity, 10) };
  if (!t.name || !(t.price >= 0) || !(t.capacity >= 0)) throw new D.UserError('Please enter a valid ticket name, price and capacity.');
  return t;
}
app.post('/admin/events', (req, res) => {
  const e = readEvent(req.body);
  D.q('INSERT INTO events (name, event_date, venue, description, on_sale, created_at) VALUES (?,?,?,?,0,?)').run(e.name, e.event_date, e.venue, e.description, D.now());
  res.redirect(withMsg('/admin/events', 'msg', 'Event created. Add ticket types, then tick "on sale".'));
});
app.post('/admin/events/:id', (req, res) => {
  const e = readEvent(req.body);
  D.q('UPDATE events SET name=?, event_date=?, venue=?, description=?, on_sale=? WHERE id=?').run(e.name, e.event_date, e.venue, e.description, req.body.on_sale ? 1 : 0, req.params.id);
  res.redirect(withMsg('/admin/events', 'msg', 'Event saved.'));
});
app.post('/admin/events/:id/types', (req, res) => {
  const t = readType(req.body);
  if (!D.getEvent(req.params.id)) throw new D.UserError('Event not found.');
  D.q('INSERT INTO ticket_types (event_id, name, price, capacity) VALUES (?,?,?,?)').run(req.params.id, t.name, t.price, t.capacity);
  res.redirect(withMsg('/admin/events', 'msg', 'Ticket type added.'));
});
app.post('/admin/types/:id', (req, res) => {
  const t = readType(req.body);
  const cur = D.q('SELECT * FROM ticket_types WHERE id = ?').get(req.params.id);
  if (!cur) throw new D.UserError('Ticket type not found.');
  const committed = D.ticketTypes(cur.event_id).find((x) => x.id === cur.id);
  if (t.capacity < committed.sold + committed.held) throw new D.UserError(`Capacity cannot go below the ${committed.sold + committed.held} tickets already sold or reserved.`);
  D.q('UPDATE ticket_types SET name=?, price=?, capacity=? WHERE id=?').run(t.name, t.price, t.capacity, cur.id);
  res.redirect(withMsg('/admin/events', 'msg', 'Ticket type saved. Price changes apply to new orders only.'));
});

// ---------- errors ----------
app.use((req, res) => res.status(404).send(page('Not found', '<h1>Page not found</h1><p><a href="/">Back to concerts</a></p>')));
app.use((err, req, res, next) => {
  if (err instanceof D.UserError || err.gateway) {
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    const back = req.get('referer') ? stripFlash(req.get('referer')) : '/';
    return res.redirect(withMsg(back, 'err', err.message));
  }
  console.error(err);
  res.status(500).send(page('Error', '<h1>Something went wrong</h1><p>Please try again.</p>'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const url = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  console.log(`Barangay Concert Tickets running (online payments: ${payMode()}):\n  Residents: ${url}\n  Admin:     ${url}/admin`);
});
