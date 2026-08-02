# livefeed auth server

Cloudflare Worker that keeps Livefeed's Google, Twitch, and Kick OAuth client secrets out of the
distributed CLI.
It uses Hono, PKCE, and short-lived Durable Object sessions.

## OAuth flow

1. The CLI creates a local PKCE verifier and sends only its challenge to
   `POST /v1/oauth/sessions` for Google, `POST /v1/oauth/twitch/sessions` for Twitch, or
   `POST /v1/oauth/kick/sessions` for Kick.
2. The Worker returns the provider authorization URL. The CLI opens it and polls the matching
   token endpoint.
3. The provider returns to its matching callback. The Worker exchanges the provider code and shows
   a minimal success page.
4. The matching CLI receives the tokens once. The session is then deleted.
5. Access-token refreshes go through `POST /v1/oauth/refresh` for YouTube or
   `POST /v1/oauth/twitch/refresh` for Twitch, or `POST /v1/oauth/kick/refresh` for Kick, so client
   secrets never ship in the npm package.

Kick chat uses signed webhooks. The Worker verifies each Kick signature, stores at most 2,000
current-stream messages for up to 24 hours, and relays events to the authenticated CLI over a
per-channel WebSocket.

OAuth sessions expire after five minutes. Durable Object alarms remove abandoned sessions.

Cloudflare-native rate limits protect each public boundary:

- 10 new sign-in sessions per source address per minute
- 90 polling or callback requests per OAuth session per minute
- 30 refreshes per saved login per minute
- 3,000 requests per route and Cloudflare location per minute as a service-wide ceiling

Rate-limited responses use HTTP `429` with `Retry-After: 60`.

## Local development

Create a Google Cloud **Web application** OAuth client. Add this authorized redirect URI:

```text
http://127.0.0.1:8787/v1/oauth/callback
```

Create a Twitch **Confidential** application and add:

```text
http://127.0.0.1:8787/v1/oauth/twitch/callback
```

Create a Kick application, enable webhooks, and add:

```text
http://127.0.0.1:8787/v1/oauth/kick/callback
```

Use `http://127.0.0.1:8787/v1/webhooks/kick` as the development webhook URL when it is externally
reachable through a tunnel.

Then:

```sh
cd server
cp .dev.vars.example .dev.vars
# Fill in all provider client IDs and client secrets.
bun install
bun run dev
```

The health endpoint is available at `http://127.0.0.1:8787`.

## Deploy

Choose the final Worker URL or custom domain first. Google requires an exact redirect URI.

```sh
cd server
bunx wrangler login
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET
bunx wrangler secret put TWITCH_CLIENT_ID
bunx wrangler secret put TWITCH_CLIENT_SECRET
bunx wrangler secret put KICK_CLIENT_ID
bunx wrangler secret put KICK_CLIENT_SECRET
bunx wrangler secret put PUBLIC_ORIGIN
bun run deploy
```

Set `PUBLIC_ORIGIN` to the HTTPS origin only, without a path or trailing slash, for example
`https://auth.livefeed.example`. Add this exact Google redirect URI:

```text
https://auth.livefeed.example/v1/oauth/callback
```

Add this exact Twitch redirect URI:

```text
https://auth.livefeed.example/v1/oauth/twitch/callback
```

Add this exact Kick redirect URI and webhook URL:

```text
https://auth.livefeed.example/v1/oauth/kick/callback
https://auth.livefeed.example/v1/webhooks/kick
```

Do not commit `.dev.vars`. Production secrets belong in Cloudflare.

## Checks

```sh
bun run check
```

The Worker is a separate package. The root CLI's npm `files` allowlist excludes `server/`.
