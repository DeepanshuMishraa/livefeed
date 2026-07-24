# livefeed auth server

Cloudflare Worker that keeps Livefeed's Google OAuth client secret out of the distributed CLI.
It uses Hono, PKCE, and short-lived Durable Object sessions.

## OAuth flow

1. The CLI creates a local PKCE verifier and sends only its challenge to
   `POST /v1/oauth/sessions`.
2. The Worker returns a Google authorization URL. The CLI opens it and polls
   `POST /v1/oauth/token`.
3. Google returns to `/v1/oauth/callback`. The Worker exchanges the Google code and shows a
   minimal success page.
4. The matching CLI receives the tokens once. The session is then deleted.
5. Access-token refreshes go through `POST /v1/oauth/refresh`, so the Google client secret never
   ships in the npm or Homebrew package.

OAuth sessions expire after five minutes. Durable Object alarms remove abandoned sessions.

## Local development

Create a Google Cloud **Web application** OAuth client. Add this authorized redirect URI:

```text
http://127.0.0.1:8787/v1/oauth/callback
```

Then:

```sh
cd server
cp .dev.vars.example .dev.vars
# Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
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
bunx wrangler secret put PUBLIC_ORIGIN
bun run deploy
```

Set `PUBLIC_ORIGIN` to the HTTPS origin only, without a path or trailing slash, for example
`https://auth.livefeed.example`. Add this exact Google redirect URI:

```text
https://auth.livefeed.example/v1/oauth/callback
```

Do not commit `.dev.vars`. Production secrets belong in Cloudflare.

## Checks

```sh
bun run check
```

The Worker is a separate package. The root CLI's npm `files` allowlist excludes `server/`.
