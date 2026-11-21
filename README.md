# Claude Remote

Read and drive your Claude Code sessions from your phone.

A Claude Code plugin plus a small relay that runs on your computer. Open the page on your phone and you get your chats as they happen: messages, tool calls, subagents, the task list. You can reply, attach photos, answer questions, approve permissions and stop a turn. It works over [Tailscale](https://tailscale.com) or on your local network, with no account and no cloud service in between.

It is for setups where Claude's own Remote Control is not available, such as Claude Code on Amazon Bedrock, Google Vertex AI or a gateway.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install remote-control --marketplace kevinschaich/claude-remote
```

From a shell:

```
claude plugin install remote-control --marketplace kevinschaich/claude-remote
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `kevinschaich/claude-remote`, then Add plugin.

That is the whole setup. The next session you start launches the relay and puts a QR code in the chat. Scan it with your phone. `/phone` shows the code again at any time.

### Requirements

- Claude Code with plugin function hooks (an early-access API; this plugin was written against 2.1.328).
- Node.js 20 or newer, or Bun, on your `PATH`.
- macOS or Linux.

## How your phone connects

The relay picks a mode when it starts.

| Mode | When | Address | Who gets in |
| --- | --- | --- | --- |
| `tailscale` | Tailscale is running and [Serve with HTTPS](https://tailscale.com/kb/1312/serve) is available | `https://<machine>.<tailnet>.ts.net/` | The tailnet login that owns the computer |
| `lan` | Otherwise | `http://<local IP>:7830/` | Any device that presents the pairing key |
| `local` | Only if you ask for it | `http://127.0.0.1:7830/` | The pairing key, from this computer only |

In `tailscale` mode the relay listens on loopback only and runs `tailscale serve` for you. Nothing is exposed to the public internet (it never uses Funnel), and Tailscale tells the relay who is calling.

In `lan` mode the relay listens on every network interface over plain HTTP. The QR code carries a random pairing key; the page stores it as a cookie and removes it from the address bar. Read the next section before using this mode on a network you do not control.

Set `CLAUDE_REMOTE_MODE` to `tailscale`, `lan` or `local` to choose a mode yourself. If you ask for `tailscale` and it is not available, the relay falls back to `local`, not to your network.

## Security

Whoever can use the page can make Claude run commands on your computer with your permissions. Treat access to it like a shell on that machine.

- **Tailscale mode** is the one to prefer. Traffic is encrypted, and only the tailnet login that owns the computer is let in. `CLAUDE_REMOTE_ALLOW=a@example.com,b@example.com` adds other logins.
- **Local-network mode sends everything, the pairing key included, unencrypted.** Anyone who can watch traffic on that network can read your chats and take the key. Use it on a home network you trust, not on shared or public Wi-Fi. `node server/cli.mjs new-key` replaces the key.
- An address that presents 20 wrong keys is shut out for ten minutes.
- The plugin talks to the relay over loopback with a separate token in `~/.claude-remote/token`. Those endpoints refuse anything that arrives from the network or through a proxy.
- Requests from other websites are refused.
- **Away mode** lets you approve permission prompts from the phone. It is off until you switch it on, and a prompt nobody answers goes back to the computer.
- Notifications are empty pushes: the text is fetched by your phone from the relay, so nothing about your chats passes through a push service.

## What you can do from the phone

- Read every chat: sessions that are open now, live, and every past chat on the computer, read-only.
- See messages as they stream, tool calls grouped and expandable (input, result, diffs, images), subagent threads, thinking, the task list.
- Send a message with photos or files. While a turn is running the message joins it.
- Answer questions and next-step buttons. Stop the running turn.
- Run slash commands and change session settings such as the model or permission mode.
- Open the session panel: folder, branch, model, context use, cost estimate, agents, files changed, connected tools.
- Get a notification when a turn ends, a question is asked or a permission is needed. This needs Tailscale mode (HTTPS); on an iPhone, add the page to the Home Screen first.

### Limits

- A chat must be open in Claude Code to accept messages. Past chats are read-only.
- A plan can be read on the phone but only approved at the computer.
- Rewind, fork and the desktop app's panes are not available.
- The relay stops when the computer sleeps or you log out.

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

### Settings

Environment variables read by the relay (and carried into the service by `service install`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_REMOTE_PORT` | `7830` | Port the relay listens on. The plugin reads it too. |
| `CLAUDE_REMOTE_MODE` | `auto` | `auto`, `tailscale`, `lan` or `local`. |
| `CLAUDE_REMOTE_ALLOW` | | Extra tailnet logins, comma-separated. |
| `CLAUDE_REMOTE_DATA` | `~/.claude-remote` | Where the relay keeps its files. |

### Files

Everything the relay stores is in `~/.claude-remote/`, readable only by you: `token` and `pair-key`, `state.json` (away mode, push subscriptions), `vapid.json` (push signing key), `sessions/` (chat event logs, kept 14 days), `uploads/` (files sent from the phone, images from tool results) and `server.log`. Deleting the folder resets everything.

## How it works

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
CLAUDE_REMOTE_PORT=7831 CLAUDE_REMOTE_DATA=/tmp/claude-remote-dev node server/cli.mjs start
```

## License

MIT
