// HTML rendering helpers shared by the resident site and the admin pages.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = (centavos) => (centavos < 0 ? '−₱' : '₱') + (Math.abs(centavos) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TZ = 'Asia/Manila';
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-PH', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '';
// Event dates are entered as local Manila time ("2026-12-19T19:00").
const fmtEventDate = (local) => new Date(local + ':00+08:00').toLocaleString('en-PH', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });
const METHOD = { online: 'Online (GCash / e-wallet)', cash: 'Cash at Barangay Hall' };
const badge = (status) => `<span class="badge ${esc(status)}">${esc(status)}</span>`;

function page(title, body, { admin, user, eventId, flash } = {}) {
  const ev = eventId ? `?event=${eventId}` : '';
  const nav = admin
    ? (user ? `<nav>
        <a href="/admin${ev}">Dashboard</a><a href="/admin/orders${ev}">Orders</a>
        <a href="/admin/checkin">Gate check-in</a><a href="/admin/expenses${ev}">Expenses</a>
        <a href="/admin/report${ev}">Financial report</a><a href="/admin/events">Events</a>
        <form method="post" action="/admin/logout" class="inline"><button class="link">Log out (${esc(user)})</button></form>
      </nav>` : '')
    : `<nav><a href="/">Concerts</a><a href="/find">Find my tickets</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body class="${admin ? 'admin' : 'public'}">
<header><div class="wrap"><a class="brand" href="${admin ? '/admin' : '/'}">🎵 Barangay Concert Tickets${admin ? ' · Admin' : ''}</a>${nav}</div></header>
<main class="wrap">${flash ? `<div class="flash ${flash.type}">${esc(flash.text)}</div>` : ''}${body}</main>
<footer class="wrap">Barangay Concert Ticketing System</footer>
</body></html>`;
}

module.exports = { esc, peso, fmtDateTime, fmtEventDate, METHOD, badge, page };
