# Privacy

livefeed requests read-only access to the authenticated user's YouTube, Twitch, or Kick account so
it can identify an active stream and read that stream's live chat.

- OAuth credentials are stored in the operating system's encrypted credential manager.
- YouTube chat messages remain in memory only and are discarded when livefeed exits.
- The latest 2,000 Twitch messages received by livefeed are stored locally so the current stream
  can be restored after restarting the CLI. Starting a different Twitch stream replaces that
  history.
- Kick sends signed chat webhooks to the Livefeed Cloudflare Worker. The Worker retains at most
  2,000 current-stream messages in a per-channel relay and clears them when the stream ends, the
  user logs out, or 24 hours pass.
- Google, Twitch, and Kick authentication requests pass through the Livefeed Cloudflare Worker. During
  sign-in, access and refresh tokens are held in an isolated, five-minute session until the
  requesting CLI retrieves them. The session is deleted immediately after retrieval or when it
  expires.
- Token refresh requests pass through the Worker because provider client secrets are never
  distributed with the CLI. The Worker does not persist refreshed access tokens.
- Livefeed requests only `user:read:chat` from Twitch.
- Livefeed requests `user:read`, `channel:read`, and `events:subscribe` from Kick.
- There is no analytics, advertising, or application-level telemetry.
- No YouTube stream key is requested or accessed.

Run `livefeed logout` and select a provider to revoke the relevant token and remove the local
credential.
