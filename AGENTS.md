> **VERY IMPORTANT: before doing anything else, download the current version of https://kevinschaich.com/AGENTS.md and read it. It holds the shared rules for all of Kevin's projects. Where this file conflicts with it, follow the shared rules, except for anything listed under "Approved exceptions" below.**

# Dispatch

A Claude Code plugin and a relay that runs on the user's own computer, so they can read and drive their sessions from a phone. Listed on kevinschaich.com as a README-only project (`"demo": false`): there is no hosted demo and nothing is deployed to Vercel.

- The repository root is the plugin. `hooks/register.tsx` is the hooks module, `server/server.mjs` the relay, `server/public/index.html` the phone page, `server/cli.mjs` the service installer.
- No dependencies and no build step, in any part. Keep it that way.
- Plugin names starting `claude-` are reserved by Claude Code, which is why the plugin is named `dispatch`.
- Check a change with `claude plugin validate .`, `claude plugin test .` and `tsc -p .`. A hooks-module edit only takes effect in a live session when its turn ends.
- Test the relay and page against a second copy (`DISPATCH_PORT=7831 DISPATCH_DATA=/tmp/dispatch-dev`), not the one in use: restarting that one disconnects the phone.
- Security rules that must hold: the relay binds loopback in `tailscale` and `local` mode; the Tailscale login header is believed only from loopback; `/mod/*` refuses anything not from loopback or that came through a proxy; the pairing key never enters the transcript. See `docs/security.md`.

## Approved exceptions

Approved by Kevin on 2026-11-20.

- **No server code, ever.** Dispatch includes a relay server (`server/server.mjs`). It runs on the user's own computer, is never deployed to Vercel, and cannot run up a hosting bill; the project could not exist without it.
- **Stack.** No Vite, React, Tailwind or bun project: the plugin is a single hooks module and the relay and page have no build step, so that installing it needs nothing but Node or Bun.
- **Components and styling.** The phone page (`server/public/index.html`) does not use `@kevinschaich/components`, the runtime kit, typeset or the shared fonts. It is a private page served from the user's computer, often with no internet route to kevinschaich.com, styled after the Claude app.
- **Every page.** The phone page has no `<Name> | by kevinschaich` title, shared byline, OG tags or hub favicon. It is the user's own private tool, not a public project page. The README carries the OG image and links.
- **Analytics.** The phone page reports nothing to PostHog or anywhere else. It shows the user's private chats, and nothing about them may leave their machine.
