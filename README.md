# livefeed

YouTube and Twitch live chat, native to your terminal.

`livefeed` finds your active YouTube or Twitch stream and follows its chat in a fast, minimal
terminal feed. YouTube public, unlisted, and private livestreams are supported.

## Install

Requires Bun 1.3 or newer on macOS or desktop Linux.

```sh
bun add --global livefeed
```

Or run it directly:

```sh
bunx livefeed yt auth
bunx livefeed yt
```

## Use

```sh
livefeed yt auth
livefeed yt

livefeed twitch auth
livefeed twitch
```

Authentication opens in your browser. No stream key, pasted token, or client secret is required.

You can start `livefeed` before going live. It stays open, reports that the stream is offline, and
connects automatically within about ten seconds of the broadcast starting. When joining an active
YouTube stream, it loads YouTube's available chat history—up to the latest 2,000 messages—before
following new messages in real time. Twitch starts with messages received after the CLI connects
because Twitch does not provide chat history through its API.

| Command | Action |
| --- | --- |
| `livefeed yt` | Open your active YouTube broadcast's chat |
| `livefeed yt auth` | Sign in with Google |
| `livefeed yt logout` | Revoke and remove the saved YouTube login |
| `livefeed twitch` | Open your active Twitch stream's chat |
| `livefeed twitch auth` | Sign in with Twitch |
| `livefeed twitch logout` | Revoke and remove the saved Twitch login |
| `livefeed` | Alias for `livefeed yt` |

Use `↑`/`↓` or `j`/`k` to scroll, `G` to jump to the latest message, and `q` to quit. Set `NO_COLOR=1` to disable color.

## Development

```sh
bun install
bun run src/index.tsx twitch auth
bun run src/index.tsx twitch
bun run src/index.tsx yt
```

```sh
bun run check
bun run build
```

Authentication uses the hosted broker in [`server/`](server/README.md), PKCE, and the read-only
YouTube scope. Twitch authentication uses the same broker with the `user:read:chat` scope. Google
and Twitch client secrets remain in Cloudflare; neither is part of the CLI build. Tokens are stored
in macOS Keychain or Linux Secret Service. There is no analytics or advertising. See
[PRIVACY.md](PRIVACY.md).

## Release

```sh
npm run deploy
```

The deploy script runs every check, builds the CLI, increments the patch version without creating a
Git tag, and publishes the public npm package. For example, `0.0.1` becomes `0.0.2`.

## License

MIT
