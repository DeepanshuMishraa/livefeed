# Privacy

livefeed requests read-only access to the authenticated user's YouTube account so it can identify an active broadcast and read that broadcast's live chat.

- OAuth refresh tokens are stored in the operating system's encrypted credential manager.
- Access tokens remain in process memory only.
- Chat messages remain in memory only and are discarded when livefeed exits.
- livefeed has no hosted backend, analytics, advertising, or telemetry.
- No YouTube stream key is requested or accessed.

Run `livefeed logout` to revoke the granted Google token and remove the local credential.
