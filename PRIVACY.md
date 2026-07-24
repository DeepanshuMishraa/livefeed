# Privacy

livefeed requests read-only access to the authenticated user's YouTube or Twitch account so it can
identify an active stream and read that stream's live chat.

- OAuth credentials are stored in the operating system's encrypted credential manager.
- Chat messages remain in memory only and are discarded when livefeed exits.
- Google and Twitch authentication requests pass through the Livefeed Cloudflare Worker. During
  sign-in, access and refresh tokens are held in an isolated, five-minute session until the
  requesting CLI retrieves them. The session is deleted immediately after retrieval or when it
  expires.
- Token refresh requests pass through the Worker because provider client secrets are never
  distributed with the CLI. The Worker does not persist refreshed access tokens.
- Livefeed requests only `user:read:chat` from Twitch.
- There is no analytics, advertising, or application-level telemetry.
- No YouTube stream key is requested or accessed.

Run `livefeed yt logout` or `livefeed twitch logout` to revoke the relevant token and remove the
local credential.
