# livefeed

YouTube, Twitch, and Kick live chat, native to your terminal.

`livefeed` finds your active YouTube, Twitch, or Kick stream and follows its chat in a fast, minimal
terminal feed. YouTube public, unlisted, and private livestreams are supported.

## Install

Requires Bun 1.3 or newer on macOS or desktop Linux.

```sh
bun add --global livefeed
```

After installation, run `livefeed update` whenever you want to check for and install a newer
version.

Or run it directly:

```sh
bunx livefeed auth
bunx livefeed
```

## Use

```sh
livefeed auth
livefeed
livefeed logout
```

When one provider is connected, `livefeed` opens that chat automatically. When multiple providers
are connected, it shows a compact selector. `livefeed auth` asks which provider to connect.
`livefeed logout` lets you remove one login or all saved logins.

Authentication opens in your browser. No stream key, pasted token, or client secret is required.

You can start `livefeed` before going live. It stays open, reports that the stream is offline, and
connects automatically within about ten seconds of the broadcast starting. When joining an active
YouTube stream, it loads YouTube's available chat history, up to the latest 2,000 messages, before
following new messages in real time. Twitch does not provide chat history through its API, so
livefeed keeps the latest 2,000 received Twitch messages locally and restores them when reopening
the same stream. Kick delivers signed chat events through the Livefeed Cloudflare relay, which
retains at most 2,000 messages for the current stream and clears them after the stream ends, logout,
or 24 hours.

| Command | Action |
| --- | --- |
| `livefeed` | Open the only connected provider or choose among connected providers |
| `livefeed auth` | Choose YouTube, Twitch, or Kick and sign in |
| `livefeed logout` | Remove one provider login or all saved logins |
| `livefeed update` | Check for and install the latest published version |

Use `↑`/`↓` or `j`/`k` to scroll, `G` to jump to the latest message, and `q` to quit. Set `NO_COLOR=1` to disable color.

## Development

```sh
bun install
bun run src/index.tsx auth
bun run src/index.tsx
bun run src/index.tsx logout
```

```sh
bun run check
bun run build
```

Authentication uses the hosted broker in [`server/`](server/README.md), PKCE, and the read-only
YouTube scope. Twitch authentication uses the same broker with the `user:read:chat` scope. Kick
uses `user:read`, `channel:read`, and `events:subscribe` so its signed webhook chat can reach the
CLI. Provider client secrets remain in Cloudflare and are not part of the CLI build. Tokens are
stored in macOS Keychain or Linux Secret Service. There is no analytics or advertising. See
[PRIVACY.md](PRIVACY.md).

## Release

```sh
npm run release:patch
```

The release script increments the version without creating a Git tag, runs every check, builds the
CLI, and publishes the public npm package with the `latest` tag. Run `npm run release:minor` when
incrementing the minor version instead. Versions `0.0.3`, `0.0.4`, and `0.0.6` have already been
used and cannot be republished.

Use `npm run deploy` to publish the exact version already set in `package.json`.

## License

MIT
