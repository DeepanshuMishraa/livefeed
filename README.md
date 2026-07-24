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

```sh
bun install
bun run src/index.tsx auth
bun run dev
```

```sh
bun run check
bun run build
```

Authentication uses the hosted broker in [`server/`](server/README.md), PKCE, and the read-only
YouTube scope. The Google client secret remains in Cloudflare; it is not part of the CLI build.
Tokens are stored in macOS Keychain or Linux Secret Service. There is no analytics or advertising.
See [PRIVACY.md](PRIVACY.md).

## Release

```sh
npm run deploy
```

The deploy script runs every check, builds the CLI, increments the patch version without creating a
Git tag, and publishes the public npm package. For example, `0.0.1` becomes `0.0.2`.

## License

MIT
