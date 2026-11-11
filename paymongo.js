// PayMongo client (Checkout Sessions, webhooks, refunds). Amounts are in centavos, same as our database.
// Docs: https://docs.paymongo.com/reference/create-a-checkout
const crypto = require('node:crypto');

const API = () => process.env.PAYMONGO_API_URL || 'https://api.paymongo.com/v1';
const key = () => process.env.PAYMONGO_SECRET_KEY || '';
const enabled = () => !!key();
const mode = () => !enabled() ? 'demo' : key().startsWith('sk_live') ? 'live' : 'test';
const methods = () => (process.env.PAYMONGO_METHODS || 'gcash,paymaya').split(',').map((s) => s.trim()).filter(Boolean);

async function call(method, path, attributes) {
  let res, body;
  try {
    res = await fetch(API() + path, {
      method,
      headers: { Authorization: 'Basic ' + Buffer.from(key() + ':').toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: attributes ? JSON.stringify({ data: { attributes } }) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw gatewayError('Could not reach the payment provider. Please try again in a moment.');
  }
  if (!res.ok) {
    const detail = body.errors?.map((e) => e.detail).filter(Boolean).join(' ') || `HTTP ${res.status}`;
    console.error('PayMongo error', method, path, res.status, JSON.stringify(body));
    throw gatewayError('Payment provider error: ' + detail);
  }
  return body.data;
}
const gatewayError = (msg) => Object.assign(new Error(msg), { gateway: true });

// Creates the hosted checkout page for an order. Returns the session ({ id, attributes.checkout_url }).
function createCheckout(order, baseUrl) {
  return call('POST', '/checkout_sessions', {
    line_items: order.items.map((i) => ({ name: i.name, amount: i.unit_price, currency: 'PHP', quantity: i.qty })),
    payment_method_types: methods(),
    success_url: `${baseUrl}/pay/${order.token}/return`,
    cancel_url: `${baseUrl}/order/${order.token}`,
    reference_number: order.ref,
    description: `${order.event_name} — order ${order.ref}`,
    billing: { name: order.buyer_name, phone: order.mobile },
    send_email_receipt: false,
  });
}
const getCheckout = (id) => call('GET', '/checkout_sessions/' + encodeURIComponent(id));
const expireCheckout = (id) => call('POST', `/checkout_sessions/${encodeURIComponent(id)}/expire`);
const refund = (paymentId, amount) => call('POST', '/refunds', { amount, payment_id: paymentId, reason: 'requested_by_customer' });
const createWebhook = (url) => call('POST', '/webhooks', { url, events: ['checkout_session.payment.paid'] });

// The one successful payment of a checkout session, or undefined if it has not been paid.
const paidPayment = (session) => (session?.attributes?.payments || []).find((p) => p.attributes?.status === 'paid');

// Paymongo-Signature: "t=<timestamp>,te=<test sig>,li=<live sig>"; sig = HMAC-SHA256(t + "." + rawBody, webhook secret).
function verifyWebhook(rawBody, header) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  if (!parts.t) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.').update(rawBody).digest('hex');
  return [parts.te, parts.li].some((sig) => sig && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

module.exports = { enabled, mode, methods, createCheckout, getCheckout, expireCheckout, refund, createWebhook, paidPayment, verifyWebhook };
