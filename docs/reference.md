# Commands, settings and files

## Keeping the relay running

The plugin starts the relay whenever a session finds it is not running, so there is nothing to do. To have it start at login and restart if it stops, install it as a service (launchd on macOS, a systemd user unit on Linux):

```
node server/cli.mjs service install
```

Other commands:

```
node server/cli.mjs status              # running? which mode? which address?
node server/cli.mjs url                 # the address a phone opens
node server/cli.mjs start               # run in the foreground
node server/cli.mjs service uninstall
node server/cli.mjs new-key             # replace the pairing key
```

In a session, `/phone` shows the QR code.

## Settings

Environment variables read by the relay, and carried into the service by `service install`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISPATCH_PORT` | `7830` | Port the relay listens on. The plugin reads it too. |
| `DISPATCH_MODE` | `auto` | `auto`, `tailscale`, `lan` or `local`. See [connecting](connecting.md). |
| `DISPATCH_ALLOW` | | Extra tailnet logins, comma-separated. |
| `DISPATCH_DATA` | `~/.dispatch` | Where the relay keeps its files. |

## Files

Everything the relay stores is in `~/.dispatch/`:

| File | Holds |
| --- | --- |
| `token` | What the plugin presents to the relay |
| `pair-key` | What a phone presents on a local network |
| `state.json` | Away mode and push subscriptions |
| `vapid.json` | The key that signs push notifications |
| `sessions/` | Chat event logs, kept 14 days |
| `uploads/` | Files sent from the phone, images from tool results |
| `server.log` | The relay's log |

## Layout

```
Claude Code session ── plugin (hooks/) ──▶ relay (server/) ◀── phone page (server/public/)
                        loopback + token      HTTP + SSE         Tailscale Serve or LAN
```

- `hooks/register.tsx` is the plugin. It mirrors transcript rows, streaming text, questions and permission prompts to the relay, and long-polls it for what the phone sends back. `hooks/qr.ts` is a dependency-free QR encoder.
- `server/server.mjs` is the relay: Node's standard library only. It holds each session's events, serves the page, and reads past chats from `~/.claude/projects`.
- `server/public/index.html` is the page: one file, no build step.

## Development

```
claude --plugin-dir .          # load the plugin from this folder
claude plugin validate .       # what the engine will accept
claude plugin test .           # tests/*.test.tsx
```

Run a second relay for experiments without touching the real one:

```
DISPATCH_PORT=7831 DISPATCH_DATA=/tmp/dispatch-dev node server/cli.mjs start
```
