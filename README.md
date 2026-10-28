# Telegram Bot Control Center

Private Telegram bot monitoring dashboard built with Cloudflare Pages, Workers, and D1. Existing Telegram bots stay independent; do not replace their webhook Workers.

## Repository layout

- `public/` — static Pages dashboard
- `worker/index.js` — Worker API and 15-minute scheduled checks
- `worker/schema.sql` — D1 schema
- `wrangler.toml` — **root Worker deployment config** (entry point: `worker/index.js`)

## Cloudflare Pages setup

Create/connect a Pages project to this repository:
- Framework preset: None
- Build command: leave blank
- Build output directory: `public`

The frontend API URL is configured in `public/config.js`. It must match the deployed Worker URL exactly.

## Cloudflare Worker setup

Use the repository root as the Worker build root so Cloudflare sees the root `wrangler.toml`. The config names the Worker `telegram-bot-control-center` and points to `worker/index.js`.

If using a Git-connected Worker build, set the root directory to `/` (repository root) and deploy. If using Wrangler locally, from the repository root run:

```bash
npx wrangler deploy
```

The health endpoint should respond with JSON at:

```
https://telegram-bot-control-center.joshdrn18.workers.dev/health
```

Expected response includes `"ok": true`. If this URL still returns a Cloudflare 404, the Worker deployment/name/route is not active yet; frontend code cannot fix an undeployed Worker.

## D1 database

The root `wrangler.toml` binds the existing D1 database `bot-control-center-db`. Do not create a second database unless the configured database ID is invalid.

Apply the schema from the repository root:

```bash
npx wrangler d1 execute bot-control-center-db --remote --file=worker/schema.sql
```

The schema uses `CREATE TABLE IF NOT EXISTS`, so it preserves existing rows.

## Required Worker secrets

Set these in Worker Settings → Variables and Secrets:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

Optional alert delivery:
- `ALERT_BOT_TOKEN`
- `ALERT_CHAT_ID`

Never commit secrets to GitHub. `SESSION_SECRET` is not required by the current session implementation.

## CORS

The Worker variable `PANEL_ORIGIN` must be the exact Pages origin, without a trailing slash:

`https://telegram-bot-control-center.pages.dev`

If Pages uses a different hostname or custom domain, update the value to that exact origin and redeploy the Worker.

## Register and monitor bots

1. Open Pages and sign in with the Worker secrets.
2. Choose **Add bot**.
3. Add a safe HTTPS health endpoint if available; otherwise leave it blank and use telemetry.
4. Copy the telemetry token once and save it as `MONITOR_TOKEN` in the relevant bot Worker. Set `MONITOR_URL` to `https://telegram-bot-control-center.joshdrn18.workers.dev/api/telemetry`.

Do not replace a working bot Worker or change its Telegram webhook just to add monitoring.

## Telemetry example

```js
async function reportMonitor(env, event) {
  if (!env.MONITOR_URL || !env.MONITOR_TOKEN) return;
  try {
    await fetch(env.MONITOR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MONITOR_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event: event.event || "heartbeat",
        severity: event.severity || "info",
        message: String(event.message || "Worker processed event").slice(0, 1000),
        source: event.source || "worker",
        group_id: event.group_id ? String(event.group_id) : null,
        metadata: event.metadata || {}
      })
    });
  } catch {
    // Monitoring must never break the bot's primary work.
  }
}
```

Avoid sending private message contents, personal data, bot tokens, or other secrets in telemetry.
