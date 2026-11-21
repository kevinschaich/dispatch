[![Dispatch by kevinschaich](https://kevinschaich.com/og/dispatch.png)](https://kevinschaich.com/project/dispatch/)

# Dispatch

Drive your Claude Code sessions from your phone.

**[Try it →](https://kevinschaich.com/project/dispatch/)**

## How it works

Dispatch is a Claude Code plugin with a small relay that runs on your own computer. Your phone opens a page served by that relay, over [Tailscale](https://tailscale.com) or your local network. There is no account and no cloud service in between.

- **Follow along.** Messages as they stream, tool calls, subagents, the task list, and every past chat on the computer.
- **Reply from anywhere.** Send messages with photos or files, answer questions, stop a turn, run slash commands, switch the model.
- **Approve from your pocket.** Turn on away mode and permission prompts come to your phone first.
- **Hear about it.** Get a notification when a turn ends or Claude needs you.

It is for setups where Claude's own Remote Control is not available, such as Claude Code on Amazon Bedrock, Google Vertex AI or a gateway.

Whoever can open the page can make Claude run commands on your computer, so read [Security](docs/security.md) before using it without Tailscale: on a local network, traffic is not encrypted.

More: [how your phone connects](docs/connecting.md) · [security](docs/security.md) · [commands, settings and files](docs/reference.md)

## Run locally

Install the plugin at the prompt of a Claude Code terminal session:

```
/plugin install dispatch --marketplace kevinschaich/dispatch
```

Or from a shell:

```
claude plugin install dispatch --marketplace kevinschaich/dispatch
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `kevinschaich/dispatch`, then Add plugin.

The next session you start launches the relay and puts a QR code in the chat. Scan it with your phone. `/phone` shows the code again.

You need Claude Code with plugin function hooks (an early-access API), Node.js 24 or newer (or Bun) on your `PATH`, and macOS or Linux.
