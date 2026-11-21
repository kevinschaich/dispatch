# How your phone connects

The relay picks a mode when it starts.

| Mode | When | Address | Who gets in |
| --- | --- | --- | --- |
| `tailscale` | Tailscale is running and [Serve with HTTPS](https://tailscale.com/kb/1312/serve) is available | `https://<machine>.<tailnet>.ts.net/` | The tailnet login that owns the computer |
| `lan` | Otherwise | `http://<local IP>:7830/` | Any device that presents the pairing key |
| `local` | Only if you ask for it | `http://127.0.0.1:7830/` | The pairing key, from this computer only |

## Tailscale

The relay listens on loopback only and runs `tailscale serve` for you. Nothing is exposed to the public internet (it never uses Funnel), and Tailscale tells the relay who is calling. If port 443 is already serving something else on the machine, Dispatch uses 8443.

Notifications need this mode, because browsers only allow them over HTTPS. On an iPhone, add the page to the Home Screen first, then turn notifications on from the menu.

## Local network

The relay listens on every network interface over plain HTTP. The QR code carries a random pairing key; the page stores it as a cookie and removes it from the address bar. Read [Security](security.md) before using this mode on a network you do not control.

If the computer's address changes (a different Wi-Fi network, say), the next session shows a new QR code.

## Choosing a mode

Set `DISPATCH_MODE` to `tailscale`, `lan` or `local`. If you ask for `tailscale` and it is not available, the relay falls back to `local`, not to your network.

## Limits

- A chat must be open in Claude Code to accept messages. Past chats are read-only.
- A plan can be read on the phone but only approved at the computer.
- Rewind, fork and the desktop app's panes are not available.
- The relay stops when the computer sleeps or you log out.
