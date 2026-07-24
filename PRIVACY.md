# Privacy

livefeed requests read-only access to the authenticated user's YouTube account so it can identify an active broadcast and read that broadcast's live chat.

- OAuth refresh tokens are stored in the operating system's encrypted credential manager.
- Access tokens remain in process memory only.
- Chat messages remain in memory only and are discarded when livefeed exits.
- Authentication requests pass through the Livefeed Cloudflare Worker. During sign-in, access and
  refresh tokens are held in an isolated, five-minute session until the requesting CLI retrieves
  them. The session is deleted immediately after retrieval or when it expires.
- Token refresh requests pass through the Worker because the Google client secret is never
  distributed with the CLI. The Worker does not persist refreshed access tokens.
- There is no analytics, advertising, or application-level telemetry.
- No YouTube stream key is requested or accessed.

Run `livefeed logout` to revoke the granted Google token and remove the local credential.
