#!/usr/bin/env node
// Runs and manages the Claude Remote relay outside a Claude session.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'server.mjs')
const DATA_DIR = process.env.CLAUDE_REMOTE_DATA ?? join(homedir(), '.claude-remote')
const PORT = process.env.CLAUDE_REMOTE_PORT ?? '7830'
const LABEL = 'com.claude-remote.server'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const UNIT = join(homedir(), '.config', 'systemd', 'user', 'claude-remote.service')
// Settings the relay reads from its environment are carried into the service.
const CARRIED = ['CLAUDE_REMOTE_PORT', 'CLAUDE_REMOTE_MODE', 'CLAUDE_REMOTE_ALLOW', 'CLAUDE_REMOTE_DATA'].filter(
  name => process.env[name],
)

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
// The runtime as the PATH names it (a stable link), not the versioned file it resolves to.
const runtime = (() => {
  try {
    const name = process.execPath.split('/').pop()
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || process.execPath
  } catch {
    return process.execPath
  }
})()
const quiet = (command, args) => {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
  } catch {}
}

async function info() {
  const token = readFileSync(join(DATA_DIR, 'token'), 'utf8').trim()
  const res = await fetch(`http://127.0.0.1:${PORT}/mod/info`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`the relay answered ${res.status}`)
  return res.json()
}

function installService() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const log = join(DATA_DIR, 'server.log')
  if (platform() === 'darwin') {
    const env = CARRIED.map(name => `    <key>${name}</key><string>${process.env[name]}</string>`).join('\n')
    mkdirSync(dirname(PLIST), { recursive: true })
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${runtime}</string>
    <string>${SERVER}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`)
    const domain = `gui/${userInfo().uid}`
    quiet('launchctl', ['bootout', `${domain}/${LABEL}`])
    // launchd lets go of the old service a moment after bootout returns.
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('launchctl', ['bootstrap', domain, PLIST], { stdio: attempt < 6 ? 'ignore' : 'inherit' })
        break
      } catch (error) {
        if (attempt >= 6) throw error
        execFileSync('sleep', ['1'])
      }
    }
    console.log(`Installed ${PLIST}. The relay now starts at login and restarts if it stops.`)
  } else if (platform() === 'linux') {
    const env = CARRIED.map(name => `Environment=${name}=${process.env[name]}`).join('\n')
    mkdirSync(dirname(UNIT), { recursive: true })
    writeFileSync(UNIT, `[Unit]
Description=Claude Remote relay
After=network-online.target

[Service]
ExecStart=${runtime} ${SERVER}
Restart=always
RestartSec=2
${env}

[Install]
WantedBy=default.target
`)
    run('systemctl', ['--user', 'daemon-reload'])
    run('systemctl', ['--user', 'enable', '--now', 'claude-remote.service'])
    console.log(`Installed ${UNIT}. Run "loginctl enable-linger $USER" to keep it running while logged out.`)
  } else {
    throw new Error('the service installer supports macOS and Linux; run "start" under your own process manager')
  }
}

function uninstallService() {
  if (platform() === 'darwin') {
    quiet('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`])
    rmSync(PLIST, { force: true })
  } else if (platform() === 'linux') {
    quiet('systemctl', ['--user', 'disable', '--now', 'claude-remote.service'])
    rmSync(UNIT, { force: true })
  }
  console.log('The relay service is removed. Its data stays in ' + DATA_DIR)
}

const [command, argument] = process.argv.slice(2)
try {
  if (command === 'start') await import('./server.mjs')
  else if (command === 'url') console.log((await info()).url)
  else if (command === 'status') {
    const { mode, url, port } = await info()
    console.log(`running on port ${port} in ${mode} mode\nphone address: ${url}`)
  } else if (command === 'service' && argument === 'install') installService()
  else if (command === 'service' && argument === 'uninstall') uninstallService()
  else if (command === 'new-key') {
    rmSync(join(DATA_DIR, 'pair-key'), { force: true })
    console.log('The pairing key is removed. Restart the relay; every paired phone must scan the new code.')
  } else {
    console.log(`Usage: node server/cli.mjs <command>

  start               run the relay in the foreground
  status              say whether it is running, and in which mode
  url                 print the address a phone opens
  service install     keep it running: launchd on macOS, systemd on Linux
  service uninstall   remove that service
  new-key             replace the pairing key (local-network mode)

Environment: CLAUDE_REMOTE_PORT (7830), CLAUDE_REMOTE_MODE (auto, tailscale,
lan, local), CLAUDE_REMOTE_ALLOW (extra tailnet logins, comma-separated).`)
    if (command && command !== 'help') process.exitCode = 1
  }
} catch (error) {
  console.error(existsSync(join(DATA_DIR, 'token')) ? `claude-remote: ${error.message}` : 'claude-remote: the relay has never run here; try "start"')
  process.exitCode = 1
}
