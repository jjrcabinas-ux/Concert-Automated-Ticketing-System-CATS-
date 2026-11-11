// One-time setup: tells PayMongo where to send "payment received" notifications,
// then saves the signing secret it returns into .env. Run with: npm run setup-webhook
const fs = require('node:fs');
const path = require('node:path');
const envFile = path.join(__dirname, '.env');
try { process.loadEnvFile(envFile); } catch { console.error('No .env file found. Copy .env.example to .env and fill it in first.'); process.exit(1); }
const PM = require('./paymongo');

(async () => {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!PM.enabled()) throw new Error('PAYMONGO_SECRET_KEY is empty in .env');
  if (!/^https:\/\//.test(base)) throw new Error('PUBLIC_URL in .env must be the public https address of this site (PayMongo cannot reach localhost).');
  const hook = await PM.createWebhook(base + '/webhooks/paymongo');
  let env = fs.readFileSync(envFile, 'utf8').replace(/^PAYMONGO_WEBHOOK_SECRET=.*\r?\n?/m, '');
  fs.writeFileSync(envFile, env.replace(/\s*$/, '\n') + 'PAYMONGO_WEBHOOK_SECRET=' + hook.attributes.secret_key + '\n');
  console.log(`Webhook ${hook.id} registered (${PM.mode()} mode) for ${hook.attributes.url}`);
  console.log('Signing secret saved to .env. Restart the site to apply it.');
})().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
