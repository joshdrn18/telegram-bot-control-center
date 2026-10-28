# Telegram Bot Control Center

A separate Cloudflare Pages + Worker + D1 monitoring center for Telegram bots.
Designed for gradual adoption: existing bots keep their own webhook and Worker.

## Included
- Dark responsive dashboard
- Admin username/password login with HttpOnly session cookie
- D1 storage for registered bots, health checks, telemetry, and errors
- Worker health checks every 15 minutes via Cron Trigger
- Internal telemetry endpoint for existing bot Workers
- Telegram alert delivery for incidents/recovery
- Per-bot telemetry bearer token generated at registration (shown once)

## Architecture
- `public/`: static dashboard for Cloudflare Pages
- `worker/index.js`: monitoring API and scheduled checks
- `worker/schema.sql`: D1 schema
- `worker/wrangler.toml`: example Worker configuration

## Deploy

### 1. Create a new GitHub repository
Create a separate repository named `telegram-bot-control-center`, upload these files, and connect it to Cloudflare Pages. Do not reuse/replace any existing bot repository.

### 2. Deploy the API Worker
From the `worker` directory:
```bash
npx wrangler d1 create bot-control-center-db
```
Put the returned database ID into `wrangler.toml`, then run:
```bash
npx wrangler d1 execute bot-control-center-db --remote --file=schema.sql
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALERT_BOT_TOKEN
npx wrangler secret put ALERT_CHAT_ID
npx wrangler deploy
```
`ALERT_BOT_TOKEN` and `ALERT_CHAT_ID` are used only to send alert messages to your private admin chat. They are optional; omit them to disable Telegram alerts.
Set a long random `SESSION_SECRET` (at least 32 characters). Use a unique admin password.

### 3. Deploy Pages
Cloudflare Pages settings:
- Framework preset: None
- Build command: leave blank
- Build output directory: `public`

Set the Pages project environment variable `API_BASE_URL` to the deployed API Worker URL, e.g. `https://bot-control-center-api.<your-subdomain>.workers.dev`. The dashboard uses this value at build/runtime only if you replace `__API_BASE_URL__` in `public/config.js` with that URL. Then redeploy Pages.

In the API Worker settings, set `PANEL_ORIGIN` to the exact deployed Pages URL, e.g. `https://telegram-bot-control-center.pages.dev`. If using a custom domain, use that exact origin instead.

### 4. Register bots
Log in to the panel and use **Add bot**. Give each bot a display name and an HTTPS health URL that returns HTTP 2xx. For internal telemetry, copy the generated token shown once and add it to that bot Worker's secret as `MONITOR_TOKEN`; set `MONITOR_URL` to `https://<api-worker-host>/api/telemetry`.

If a bot does not have a safe health endpoint yet, leave the health URL blank and rely on telemetry until you add a non-invasive endpoint. Do not point the monitor at endpoints that trigger jobs or mutate data.

### 5. Integrate telemetry into existing bot Workers
Never replace a working bot Worker just to add monitoring. Add a helper like this to the existing code and call it from error handlers / key processing paths:

```js
async function reportMonitor(env, event) {
  if (!env.MONITOR_URL || !env.MONITOR_TOKEN) return;
  try {
    await fetch(env.MONITOR_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.MONITOR_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event: event.event || "heartbeat",
        severity: event.severity || "info",
        message: String(event.message || "Worker processed event").slice(0, 1000),
        source: event.source || "worker",
        group_id: event.group_id ? String(event.group_id) : null,
        metadata: event.metadata || {}
      }),
      signal: AbortSignal.timeout(2500)
    });
  } catch {
    // Monitoring must never break the bot's primary work.
  }
}
```

Call `reportMonitor(env, { event: "heartbeat", message: "Update processed" })` after a successful meaningful operation, and call it in `catch` blocks with `severity: "error"`. For Telegram group activity, pass `group_id: update.message?.chat?.id` (or the equivalent chat id in your update handler). Avoid including message text, private user data, bot tokens, or other secrets in telemetry.

### Status meanings
- `healthy`: latest health check succeeded or heartbeat received
- `degraded`: a reported error or failed health check
- `stale`: no recent heartbeat (more than 30 minutes)
- `unknown`: never checked / no health URL yet

## Security notes
- Keep Worker secrets out of GitHub and Pages.
- Keep this panel private. Add Cloudflare Access in front of Pages if available to you.
- The initial build intentionally does not store Telegram bot tokens or query each bot's `getWebhookInfo`; it checks safe health URLs and telemetry. This avoids centralizing powerful bot credentials. Webhook-specific checks can be added later per bot using a dedicated read-only credential strategy.
- Group visibility depends on the bot actually receiving Telegram updates. Telegram privacy mode and group permissions affect which messages/commands the bot receives.
