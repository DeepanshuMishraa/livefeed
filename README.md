# livefeed

YouTube live chat, native to your terminal.

`livefeed` finds your active broadcast and streams its chat into a fast, minimal terminal feed. It supports public, unlisted, and private livestreams.

## Install

Requires Bun 1.3 or newer on macOS or desktop Linux.

```sh
bun add --global livefeed
```

Or run it directly:

```sh
bunx livefeed auth
bunx livefeed
```

## Use

```sh
livefeed auth
livefeed
```

Authentication opens in your browser. No stream key or pasted token is required.

| Command | Action |
| --- | --- |
| `livefeed` | Open the newest active broadcast's chat |
| `livefeed auth` | Sign in with Google |
| `livefeed logout` | Revoke and remove the saved login |

Use `↑`/`↓` or `j`/`k` to scroll, `G` to jump to the latest message, and `q` to quit. Set `NO_COLOR=1` to disable color.

## Development

Create a Google Cloud Desktop OAuth client, enable YouTube Data API v3, and add yourself as a test user.

```sh
export LIVEFEED_GOOGLE_CLIENT_ID="..."
bun install
bun run src/index.tsx auth
bun run dev
```

```sh
bun run check
bun run build
```

Authentication uses PKCE and the read-only YouTube scope. Tokens are stored in macOS Keychain or Linux Secret Service. There is no telemetry. See [PRIVACY.md](PRIVACY.md).

## License

MIT
