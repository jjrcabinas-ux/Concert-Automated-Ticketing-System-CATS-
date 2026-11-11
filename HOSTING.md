# Putting CATS online

The site needs two things from a host:

1. **Run the code from GitHub.** The included `Dockerfile` works on any host that supports Docker.
2. **A persistent disk (volume).** All orders, tickets and expenses live in one database file. Without a volume it is **erased on every redeploy**.

Free plans usually lack a persistent disk, so expect a small monthly cost. Check the host's pricing page before you start.

The steps below use **Railway** because it deploys straight from your GitHub repo and has volumes. Railway's screens change from time to time, so the button names may differ slightly.

## 1. Create the service

1. Sign up at railway.com using **Login with GitHub**.
2. Click **New Project → Deploy from GitHub repo** and pick `Concert-Automated-Ticketing-System-CATS-`. Allow Railway access to that repo when asked.
3. Railway finds the `Dockerfile` and starts building. The first deploy may fail until step 3 is done — that's fine.

## 2. Attach the volume (do not skip)

1. In the project, right-click the service (or use **+ New → Volume**) and add a **Volume** to it.
2. Set the **mount path** to `/data`.

## 3. Add the settings

In the service, open **Variables** and add:

| Name | Value |
|---|---|
| `ADMIN_PASSWORD` | A strong password you choose, at least 10 characters. This is the admin login. |
| `PUBLIC_URL` | Your site's address from step 4, e.g. `https://cats-production.up.railway.app` (no trailing slash). |

Leave the PayMongo variables out for now. Without them the site runs **cash-only**: residents reserve online and pay at the Barangay Hall. The demo payment button never appears on the hosted site.

## 4. Get the public address

1. Open **Settings → Networking** and click **Generate Domain**. If it asks for a port, enter `3000`.
2. Copy the address into the `PUBLIC_URL` variable, then redeploy.
3. Optional: under the same section you can attach your own domain, e.g. `tickets.yourbarangay.ph`. If you do, update `PUBLIC_URL` to match.

## 5. Check it works

- Open the address: the concert page should load.
- Open `/admin`, log in as `admin` with your `ADMIN_PASSWORD`.
- Update the sample event under **Events** with your real concert, prices and capacity.
- Place a test cash order, receive it in **Orders**, then **Refund** it so it doesn't count in the report.
- Redeploy once and confirm the test order is still there. That proves the volume is working.

## 6. Turn on PayMongo (when ready)

1. Add these variables: `PAYMONGO_SECRET_KEY` (start with `sk_test_...`) and, optionally, `PAYMONGO_METHODS` (default `gcash,paymaya`).
2. Register the payment notification once from your own computer. In the project folder, put the same key and `PUBLIC_URL` in a `.env` file and run:

   ```bash
   npm run setup-webhook
   ```

   It prints a success line and writes `PAYMONGO_WEBHOOK_SECRET=whsk_...` into your local `.env`.
3. Copy that `PAYMONGO_WEBHOOK_SECRET` value into Railway's Variables. Railway redeploys automatically.
4. The admin dashboard now says "PayMongo is connected in TEST mode". Make a few test payments.
5. To go live: replace the key with `sk_live_...` (locally and on Railway), run step 2 again, and copy the new webhook secret to Railway.

## Day-to-day

- **Updating the site:** push changes to the `main` branch on GitHub; Railway redeploys automatically.
- **Changing the admin password:** edit `ADMIN_PASSWORD` in Variables. Everyone logged in is signed out.
- **Backups:** download the financial report and orders CSV after each sales day. Railway volumes also offer backups in the volume settings — turn them on if your plan allows.
- **Logs:** the service's **Deployments → Logs** tab shows errors and PayMongo problems.

## Other hosts

Any host works if it can build the `Dockerfile`, mount a persistent volume at `/data`, and set the variables above — for example Fly.io, Render (paid instance with a disk), or a small VPS with Docker. The `/healthz` address returns `ok` for uptime checks.
