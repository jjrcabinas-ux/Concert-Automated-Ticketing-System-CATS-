# Barangay Concert Tickets

Online ticket selling for barangay concerts — from the resident's purchase to the financial report.

## Run it

```bash
npm install
```

```bash
npm start
```

- Residents: http://localhost:3000
- Admin: http://localhost:3000/admin — login is in `data/admin-credentials.txt` (created on first run)

## What is automated

| Step | How it works |
|---|---|
| Selling | Residents pick tickets, enter name / mobile / purok, and pay online or reserve to pay cash at the Barangay Hall. |
| Stock | Availability is live. Unpaid orders hold tickets and are released automatically (20 min online, 48 h cash). Overselling is blocked. |
| Tickets | On payment, one QR e-ticket per seat is issued instantly on the order page. "Find my tickets" recovers it by order no. + mobile. |
| Cash | Treasurer clicks **Receive cash** on the order; the system records who received it. |
| Gate | Staff scan the QR (or type the code). Each ticket admits once; reuse and refunded tickets are rejected. |
| Finance | Income statement, sales by type, collections by method, payment fees, cash to remit per staff, daily sales and attendance — always computed from the transactions. Print/PDF and CSV export. |

## Online payments (PayMongo)

Without keys the site shows a demo payment screen. To collect real GCash / Maya payments:

1. Create a PayMongo account and get your **secret key** (Dashboard → Developers → API keys). Use the test key first (`sk_test_...`).
2. Copy `.env.example` to `.env` and fill in `PAYMONGO_SECRET_KEY` and `PUBLIC_URL` (the site's public https address).
3. Run `npm run setup-webhook` once — it registers the payment notification with PayMongo and saves the signing secret to `.env`.
4. Restart the site. The admin dashboard shows whether PayMongo is in test or live mode.
5. When test payments work, replace the key with the live one (`sk_live_...`) and run step 3 again.

How it behaves:

- The resident is sent to PayMongo's checkout page. Tickets are issued when PayMongo confirms payment (by webhook, and re-checked when the resident returns or opens their order).
- PayMongo's fee on each payment is recorded and shown as an expense line in the financial report.
- **Refund** on an online order sends the money back through PayMongo.
- A payment that arrives after the hold expired is honoured if seats are still free, otherwise refunded automatically.

## Files

- `server.js` — pages and routes
- `db.js` — database and business rules
- `paymongo.js`, `setup-webhook.js` — PayMongo integration
- `views.js`, `public/style.css` — layout
- `data/tickets.db` — all records (back this file up)

## Before going live

- Host it on a server with HTTPS so residents can reach it from their phones, and so PayMongo can reach `/webhooks/paymongo`.
- The PayMongo integration was tested against a local stand-in for their API, not yet with a real account — run a few test-mode payments first.
- Back up `data/tickets.db` regularly.
