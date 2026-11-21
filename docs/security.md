# Security

Whoever can use the page can make Claude run commands on your computer with your permissions. Treat access to it like a shell on that machine.

## Tailscale mode

This is the mode to prefer. Traffic is encrypted, the relay is reachable only from your tailnet, and only the tailnet login that owns the computer is let in. `DISPATCH_ALLOW=a@example.com,b@example.com` adds other logins.

Tailscale Serve puts the caller's login in a header it sets itself, and strips any copy a client sent. The relay believes that header only on connections from loopback, which is where Serve connects from.

## Local-network mode

**Everything is sent unencrypted, the pairing key included.** Anyone who can watch traffic on that network can read your chats and take the key. Use it on a home network you trust, not on shared or public Wi-Fi.

- The pairing key is 24 random bytes, kept in `~/.dispatch/pair-key`.
- An address that presents 20 wrong keys is shut out for ten minutes.
- `node server/cli.mjs new-key` replaces the key. Restart the relay afterwards; every paired phone must scan the new code.

## In every mode

- The plugin talks to the relay over loopback with a separate token in `~/.dispatch/token`. Those endpoints refuse anything that arrives from the network or through a proxy.
- Programs running as you on the same computer are trusted: they can read that token.
- Requests from other websites are refused.
- Away mode, which lets you approve permission prompts from the phone, is off until you switch it on. A prompt nobody answers goes back to the computer.
- Notifications are empty pushes. Your phone fetches the text from the relay, so nothing about your chats passes through a push service.
- The QR code is drawn in the chat but its address is not written into the transcript, so the pairing key is not sent to the model.

## What is stored

Everything is in `~/.dispatch/`, readable only by you. It includes copies of your chat history (kept 14 days) and the files you send from the phone. Deleting the folder resets everything.
