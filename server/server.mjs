#!/usr/bin/env node
// Claude Remote relay: the mod pushes session events here and long-polls for
// commands; the phone UI reads events over SSE and posts commands back.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.CLAUDE_REMOTE_PORT ?? 7830)
const DATA_DIR = process.env.CLAUDE_REMOTE_DATA ?? join(homedir(), '.claude-remote')
const TOKEN_PATH = join(DATA_DIR, 'token')
const SESSIONS_DIR = join(DATA_DIR, 'sessions')
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const STATE_PATH = join(DATA_DIR, 'state.json')
const VAPID_PATH = join(DATA_DIR, 'vapid.json')
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const DESKTOP_DIR = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
const MAX_TRANSCRIPT_BYTES = 48 * 1024 * 1024
const MAX_ARCHIVES = 6
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public')
const MAX_EVENTS = 4000
const MAX_BODY = 64 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const POLL_HOLD_MS = 25_000
const ONLINE_WINDOW_MS = 45_000
const KEEP_SESSIONS_MS = 14 * 24 * 3600_000
const ATTACHED = 'Attached files (saved on this machine, read them with the Read tool):'
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}
const EXT_OF = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|notify\.windows\.com)$/

for (const dir of [DATA_DIR, SESSIONS_DIR, UPLOAD_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 })
if (!existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, randomBytes(32).toString('hex'), { mode: 0o600 })
const TOKEN = readFileSync(TOKEN_PATH, 'utf8').trim()
// What a phone presents when no tailnet identity vouches for it.
const PAIR_PATH = join(DATA_DIR, 'pair-key')
if (!existsSync(PAIR_PATH)) writeFileSync(PAIR_PATH, randomBytes(24).toString('base64url'), { mode: 0o600 })
const PAIR_KEY = readFileSync(PAIR_PATH, 'utf8').trim()

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (path, value) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

// away: permission prompts go to the phone. subscriptions: push endpoints.
const state = { away: false, subscriptions: [], ...readJson(STATE_PATH, {}) }
const saveState = () => writeJson(STATE_PATH, state)

// ---- where the phone reaches the relay
// tailscale: loopback only, published by Tailscale Serve over HTTPS, the
//   caller's tailnet login checked. lan: every interface, plain HTTP, the
//   pairing key checked. local: loopback only, the pairing key checked.
const TAILSCALE_BINARIES = [
  'tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]
let tailscaleBinary = null
function tailscale(args, timeout = 8000) {
  for (const binary of tailscaleBinary ? [tailscaleBinary] : TAILSCALE_BINARIES) {
    try {
      const out = execFileSync(binary, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
      tailscaleBinary = binary
      return out
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('tailscale is not installed')
}

function tailnet() {
  try {
    const status = JSON.parse(tailscale(['status', '--json']))
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
    if (status.BackendState !== 'Running' || !dnsName) return null
    return { dnsName, owner: status.User?.[status.Self?.UserID]?.LoginName?.toLowerCase() ?? '' }
  } catch {
    return null
  }
}

// Publishes the relay to the tailnet and answers its address; null when
// Tailscale Serve is not available (HTTPS not enabled for the tailnet, say).
function serveOnTailnet(dnsName) {
  try {
    const web = JSON.parse(tailscale(['serve', 'status', '--json']) || '{}').Web ?? {}
    const ours = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${PORT}/?$`)
    for (const [hostPort, site] of Object.entries(web)) {
      if (ours.test(site?.Handlers?.['/']?.Proxy ?? '')) return `https://${hostPort.replace(/:443$/, '')}/`
    }
    const httpsPort = web[`${dnsName}:443`] ? 8443 : 443
    tailscale(['serve', '--bg', ...(httpsPort === 443 ? [] : [`--https=${httpsPort}`]), String(PORT)], 20_000)
    return `https://${dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}/`
  } catch (error) {
    console.error('tailscale serve is not available:', String(error.message).split('\n')[0])
    return null
  }
}

function lanAddress() {
  const found = []
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const [a, b] = address.address.split('.').map(Number)
      if (a === 169 || (a === 100 && b >= 64 && b < 128)) continue
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)
      found.push({ address: address.address, rank: isPrivate ? 0 : 1 })
    }
  }
  return found.sort((x, y) => x.rank - y.rank)[0]?.address ?? null
}

const WANTED_MODE = (process.env.CLAUDE_REMOTE_MODE ?? 'auto').toLowerCase()
const extraLogins = (process.env.CLAUDE_REMOTE_ALLOW ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const net = { mode: 'local', host: '127.0.0.1', tailnetUrl: '', allowed: new Set(extraLogins) }
{
  const tail = WANTED_MODE === 'auto' || WANTED_MODE === 'tailscale' ? tailnet() : null
  const served = tail ? serveOnTailnet(tail.dnsName) : null
  if (served) {
    net.mode = 'tailscale'
    net.tailnetUrl = served
    if (tail.owner) net.allowed.add(tail.owner)
  } else if (WANTED_MODE === 'auto' || WANTED_MODE === 'lan') {
    net.mode = 'lan'
    net.host = '0.0.0.0'
  }
}
// The address a phone opens. The local-network one changes with the network.
const phoneUrl = () =>
  net.mode === 'tailscale'
    ? net.tailnetUrl
    : `http://${(net.mode === 'lan' && lanAddress()) || '127.0.0.1'}:${PORT}/?key=${PAIR_KEY}`
if (net.mode === 'tailscale') {
  setInterval(() => {
    const owner = tailnet()?.owner
    if (owner) net.allowed = new Set([...extraLogins, owner])
  }, 10 * 60_000).unref()
}

// ---- sessions
/** @type {Map<string, any>} */
const sessions = new Map()
const PERSISTED = ['id', 'meta', 'title', 'events', 'seq', 'isBusy', 'hasEnded', 'question', 'permission', 'createdAt', 'updatedAt']
const safeId = id => String(id).replace(/[^\w-]/g, '_')

function sessionOf(id) {
  let session = sessions.get(id)
  if (!session) {
    session = {
      id, meta: {}, title: '', events: [], seq: 0, isBusy: false, hasEnded: false,
      question: null, permission: null, createdAt: Date.now(), updatedAt: Date.now(),
      inbox: [], pollWaiter: null, streams: new Set(), lastSeen: 0,
      live: null, owner: null, decisions: new Map(), decisionWaiters: new Map(), saveTimer: null,
    }
    sessions.set(id, session)
  }
  return session
}

function persist(session) {
  if (session.saveTimer || session.isArchive) return
  session.saveTimer = setTimeout(() => {
    session.saveTimer = null
    try {
      writeJson(join(SESSIONS_DIR, `${safeId(session.id)}.json`), Object.fromEntries(PERSISTED.map(k => [k, session[k]])))
    } catch (error) {
      console.error('persist failed', error.message)
    }
  }, 1500)
}

for (const file of readdirSync(SESSIONS_DIR)) {
  if (!file.endsWith('.json')) continue
  const path = join(SESSIONS_DIR, file)
  const saved = readJson(path, null)
  if (!saved?.id || Date.now() - (saved.updatedAt ?? 0) > KEEP_SESSIONS_MS) {
    try { unlinkSync(path) } catch {}
    continue
  }
  // Nothing was running across a restart of the relay as far as it can tell.
  Object.assign(sessionOf(saved.id), saved, { isBusy: false })
}

function summaryOf(session) {
  return {
    id: session.id,
    isArchive: session.isArchive === true,
    title: desktopRecord(session.id)?.title || session.title || session.meta.cwd?.split('/').pop() || session.id.slice(0, 8),
    cwd: session.meta.cwd ?? '',
    model: session.meta.model ?? '',
    usage: session.meta.usage ?? null,
    isBusy: session.isBusy,
    isOnline: !session.hasEnded && Date.now() - session.lastSeen < ONLINE_WINDOW_MS,
    hasQuestion: session.question !== null || session.permission !== null,
    updatedAt: session.updatedAt,
    seq: session.seq,
    away: state.away,
  }
}

// ---- past chats: the desktop app's session records and the CLI's transcripts
const history = { at: 0, chats: [], paths: new Map(), records: new Map() }
const headCache = new Map()

function readChunk(path, start, length) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    return buffer.subarray(0, readSync(fd, buffer, 0, length, start)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const blocksOf = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])
const textOfBlocks = blocks => blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
const isTyped = (record, text) => record.type === 'user' && !record.isMeta && !record.isSidechain && text !== '' && !text.startsWith('<')

// A transcript's folder and first prompt, read from its first part only.
function headOf(path, mtimeMs) {
  const cached = headCache.get(path)
  if (cached?.mtimeMs === mtimeMs) return cached
  const head = { mtimeMs, title: '', cwd: '' }
  try {
    for (const line of readChunk(path, 0, 384 * 1024).split('\n')) {
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (!head.cwd && typeof record.cwd === 'string') head.cwd = record.cwd
      const text = textOfBlocks(blocksOf(record.message?.content))
      if (isTyped(record, text)) {
        head.title = text.split('\n\nAttached files (')[0].replace(/\s+/g, ' ').slice(0, 80)
        break
      }
    }
  } catch {}
  headCache.set(path, head)
  return head
}

function scanHistory() {
  if (Date.now() - history.at < 20_000) return history
  const records = new Map()
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1)
      else if (entry.isFile() && entry.name.startsWith('local_') && entry.name.endsWith('.json')) {
        const record = readJson(path, null)
        if (record?.cliSessionId) {
          records.set(record.cliSessionId, {
            title: typeof record.title === 'string' ? record.title : '',
            cwd: record.cwd ?? '',
            isArchived: record.isArchived === true,
            lastActivityAt: Number(record.lastActivityAt) || 0,
          })
        }
      }
    }
  }
  walk(DESKTOP_DIR, 0)
  const paths = new Map()
  const files = []
  let projects = []
  try { projects = readdirSync(PROJECTS_DIR, { withFileTypes: true }) } catch {}
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let names = []
    try { names = readdirSync(join(PROJECTS_DIR, project.name)) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(PROJECTS_DIR, project.name, name)
      try {
        const stat = statSync(path)
        files.push({ id: name.slice(0, -6), path, mtimeMs: stat.mtimeMs })
        paths.set(name.slice(0, -6), path)
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  history.chats = files.slice(0, 400).flatMap(file => {
    const record = records.get(file.id)
    const head = record?.title && record.cwd ? null : headOf(file.path, file.mtimeMs)
    const title = record?.title || head?.title
    if (!title) return []
    return [{
      id: file.id,
      title,
      cwd: record?.cwd || head?.cwd || '',
      updatedAt: Math.round(file.mtimeMs),
      isArchived: record?.isArchived === true,
      isDesktop: record !== undefined,
    }]
  })
  history.paths = paths
  history.records = records
  history.at = Date.now()
  return history
}
const desktopRecord = id => history.records.get(id)

// A stored transcript as the events the phone page draws.
function transcriptEvents(path) {
  const size = statSync(path).size
  const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES)
  const lines = readChunk(path, start, size - start).split('\n')
  if (start > 0) lines.shift()
  const events = []
  let cwd = ''
  let seq = 0
  const add = (event, record) => events.push({ ...event, seq: ++seq, at: Date.parse(record.timestamp) || 0 })
  for (const line of lines) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (typeof record.cwd === 'string') cwd = record.cwd
    if (record.isSidechain || (record.type !== 'user' && record.type !== 'assistant')) continue
    const blocks = blocksOf(record.message?.content)
    if (record.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) add({ type: 'assistant', text: b.text }, record)
        else if (b.type === 'thinking' && b.thinking?.trim()) add({ type: 'thinking', text: clip(b.thinking, 6000) }, record)
        else if (b.type === 'tool_use') add({ type: 'tool_use', id: b.id, name: b.name, input: clipDeep(b.input), done: true }, record)
      }
      continue
    }
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      const inner = blocksOf(b.content)
      add({ type: 'tool_result', id: b.tool_use_id, text: clip(textOfBlocks(inner) || (inner.some(i => i.type === 'image') ? '[image]' : ''), 6000), isError: b.is_error === true }, record)
    }
    const text = textOfBlocks(blocks)
    if (isTyped(record, text)) add({ type: 'user', text: clip(text, 6000) }, record)
  }
  return { events: events.slice(-MAX_EVENTS), cwd, seq }
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text)
const clipDeep = (value, depth = 0) => {
  if (typeof value === 'string') return clip(value, 4000)
  if (value === null || typeof value !== 'object' || depth > 4) return value
  if (Array.isArray(value)) return value.slice(0, 50).map(v => clipDeep(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipDeep(v, depth + 1)]))
}

// Opens a past chat read-only; it turns live if its session starts again.
function loadArchive(id) {
  const path = scanHistory().paths.get(id)
  if (!path) return null
  const parsed = transcriptEvents(path)
  const loaded = [...sessions.values()].filter(s => s.isArchive && s.streams.size === 0)
  for (const old of loaded.slice(0, Math.max(0, loaded.length - MAX_ARCHIVES + 1))) sessions.delete(old.id)
  const session = sessionOf(id)
  const entry = history.chats.find(c => c.id === id)
  Object.assign(session, {
    isArchive: true, events: parsed.events, seq: parsed.seq, title: entry?.title ?? '',
    meta: { cwd: parsed.cwd || entry?.cwd || '' }, updatedAt: entry?.updatedAt ?? Date.now(),
  })
  return session
}

// Image bytes the mod sends inside an event are written to disk and the event
// keeps their paths.
function storeImages(session, event) {
  if (!Array.isArray(event.images)) return
  const dir = join(UPLOAD_DIR, safeId(session.id))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  event.images = event.images.flatMap((image, i) => {
    const ext = EXT_OF[image?.mediaType]
    if (!ext || typeof image.data !== 'string') return []
    const path = join(dir, `img-${Date.now().toString(36)}-${session.seq}-${i}${ext}`)
    writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return [path]
  })
}

function addEvents(session, events) {
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object' || typeof raw.type !== 'string') continue
    // Streaming text is shown live and never stored: the finished row follows.
    // The newest one is kept so a phone that connects mid-response sees it.
    if (raw.type === 'delta') {
      session.live = { ...raw, seq: session.seq }
      broadcast(session, session.live)
      continue
    }
    if (!raw.agentId && (raw.type === 'assistant' || raw.type === 'turn' || raw.type === 'ended')) session.live = null
    const event = { ...raw, seq: ++session.seq, at: Date.now() }
    storeImages(session, event)
    if (event.type === 'user' && !session.title && typeof event.text === 'string') {
      session.title = event.text.split('\n\nAttached files (')[0].replace(/\s+/g, ' ').slice(0, 80)
    }
    if (event.type === 'turn' && !event.agentId) {
      session.isBusy = event.state === 'start'
      if (event.state === 'end') {
        session.permission = null
        if (session.streams.size === 0) {
          const last = session.events.findLast(e => e.type === 'assistant' && !e.agentId)
          notify(session, event.reason === 'answer' || !event.reason ? 'Claude finished' : `Turn ended: ${event.reason}`, last?.text ?? '')
        }
      }
    }
    if (event.type === 'question') {
      session.question = event
      notify(session, 'Claude has a question', event.questions?.[0]?.question ?? '')
    }
    if (event.type === 'question_done' && session.question?.toolUseId === event.toolUseId) session.question = null
    if (event.type === 'permission') {
      session.permission = event
      notify(session, `Allow ${event.tool}?`, event.summary ?? '')
    }
    if (event.type === 'permission_done' && session.permission?.id === event.id) session.permission = null
    if (event.type === 'ended') {
      session.hasEnded = true
      session.isBusy = false
      session.question = null
      session.permission = null
    }
    session.events.push(event)
    if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS)
    session.updatedAt = event.at
    broadcast(session, event)
  }
  persist(session)
}

function broadcast(session, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const stream of session.streams) stream.write(frame)
}

function pushCommand(session, command) {
  session.inbox.push({ id: randomBytes(6).toString('hex'), ...command })
  flushPoll(session)
}

function endPoll(session, body) {
  const waiter = session.pollWaiter
  if (!waiter) return
  session.pollWaiter = null
  clearTimeout(waiter.timer)
  sendJson(waiter.res, 200, body)
}

function flushPoll(session) {
  if (session.pollWaiter && session.inbox.length > 0) {
    endPoll(session, { known: true, away: state.away, commands: session.inbox.splice(0) })
  }
}

// ---- web push (no payload: the service worker fetches the text itself)
const b64url = data => Buffer.from(data).toString('base64url')
if (!existsSync(VAPID_PATH)) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  writeJson(VAPID_PATH, {
    publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  })
}
const vapid = readJson(VAPID_PATH, {})
const vapidKey = createPrivateKey(vapid.privateKey)
let lastNotice = null

function vapidHeader(endpoint) {
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:claude-remote@localhost.invalid',
  }))
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: vapidKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`
}

function notify(session, title, body) {
  lastNotice = {
    title,
    body: String(body).replace(/\s+/g, ' ').slice(0, 180),
    url: `/?s=${encodeURIComponent(session.id)}`,
    tag: session.id,
    at: Date.now(),
  }
  for (const endpoint of [...state.subscriptions]) {
    fetch(endpoint, {
      method: 'POST',
      headers: { authorization: vapidHeader(endpoint), ttl: '900', urgency: 'high', 'content-length': '0' },
    }).then(res => {
      if (res.status === 404 || res.status === 410) {
        state.subscriptions = state.subscriptions.filter(e => e !== endpoint)
        saveState()
      } else if (!res.ok) console.error(`push answered ${res.status} from ${new URL(endpoint).host}`)
    }).catch(error => console.error('push failed', error.message))
  }
}

// ---- http helpers
function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readRaw(req, max) {
  return new Promise((done, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > max) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
const readBody = async req => {
  const raw = await readRaw(req, MAX_BODY)
  return raw.length ? JSON.parse(raw.toString('utf8')) : {}
}

function hasToken(req, url) {
  const header = req.headers.authorization ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '')
  const a = Buffer.from(given)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
const cookieOf = (req, name) =>
  (req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).find(([k]) => k === name)?.[1] ?? ''
const sameText = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
// Wrong keys are counted per address, and an address that keeps guessing is shut out for a while.
const wrongKeys = new Map()
function isLockedOut(req) {
  const entry = wrongKeys.get(req.socket.remoteAddress)
  return entry !== undefined && entry.count >= 20 && Date.now() - entry.since < 10 * 60_000
}
function countWrongKey(req) {
  const address = req.socket.remoteAddress
  const entry = wrongKeys.get(address)
  if (!entry || Date.now() - entry.since > 10 * 60_000) wrongKeys.set(address, { count: 1, since: Date.now() })
  else entry.count++
}

// Who may use the phone API. Through Tailscale Serve the caller's login is in
// a header Serve sets itself (and strips from what a client sent); Serve
// connects over loopback, so the header is believed from there alone.
// Otherwise the caller presents the pairing key, in the address or a cookie.
function isAllowedViewer(req, url) {
  if (net.mode === 'tailscale' && isLoopback(req)) {
    const login = String(req.headers['tailscale-user-login'] ?? '').toLowerCase()
    if (login && net.allowed.has(login)) return true
  }
  if (isLockedOut(req)) return false
  const key = url.searchParams.get('key') ?? cookieOf(req, 'cr_key')
  if (key) {
    if (sameText(key, PAIR_KEY)) return true
    countWrongKey(req)
  }
  return isLoopback(req) && hasToken(req, url)
}

// Cross-site pages may not post commands: a browser attaches Origin to those.
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon.png': ['icon.png', 'image/png'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
}

// ---- the mod's side
// The newest copy of the mod to say hello owns the session; an older copy (a
// reload's leftover, a second load of the same mod) is told to stand by.
function isOwner(session, instance) {
  return !session.owner || !instance || session.owner === instance
}

async function handleMod(req, res, url) {
  // The mod runs on this machine: never through a proxy, never from the network.
  if (!isLoopback(req) || req.headers['x-forwarded-for'] || !hasToken(req, url)) {
    return sendJson(res, 401, { error: 'bad token' })
  }
  if (req.method === 'GET' && url.pathname === '/mod/info') {
    return sendJson(res, 200, { url: phoneUrl(), mode: net.mode, port: PORT })
  }

  if (req.method === 'POST' && url.pathname === '/mod/hello') {
    const body = await readBody(req)
    const isKnown = sessions.has(body.session)
    const session = sessionOf(String(body.session))
    if (body.instance && session.owner !== body.instance) {
      session.owner = body.instance
      endPoll(session, { known: true, standby: true, commands: [] })
    }
    session.meta = { ...session.meta, ...body.meta }
    session.lastSeen = Date.now()
    session.hasEnded = false
    session.isArchive = false
    persist(session)
    return sendJson(res, 200, { known: isKnown && session.events.length > 0, url: phoneUrl(), mode: net.mode, away: state.away })
  }

  if (req.method === 'POST' && url.pathname === '/mod/events') {
    const body = await readBody(req)
    const session = sessionOf(String(body.session))
    if (!isOwner(session, body.instance)) return sendJson(res, 200, { ok: false, standby: true })
    session.lastSeen = Date.now()
    if (body.meta) {
      session.meta = { ...session.meta, ...body.meta }
      broadcast(session, { type: 'status', summary: summaryOf(session) })
      persist(session)
    }
    if (body.reset === true) {
      session.events = []
      session.question = null
      session.permission = null
      session.live = null
      broadcast(session, { type: 'reset', seq: session.seq })
    }
    addEvents(session, Array.isArray(body.events) ? body.events : [])
    return sendJson(res, 200, { ok: true, seq: session.seq })
  }

  if (req.method === 'GET' && url.pathname === '/mod/poll') {
    const id = url.searchParams.get('session') ?? ''
    if (!sessions.has(id)) return sendJson(res, 200, { known: false, commands: [] })
    const session = sessionOf(id)
    if (!isOwner(session, url.searchParams.get('instance'))) {
      return sendJson(res, 200, { known: true, standby: true, commands: [] })
    }
    session.lastSeen = Date.now()
    endPoll(session, { known: true, away: state.away, commands: [] })
    if (session.inbox.length > 0) {
      return sendJson(res, 200, { known: true, away: state.away, commands: session.inbox.splice(0) })
    }
    const timer = setTimeout(() => {
      if (session.pollWaiter?.res === res) session.pollWaiter = null
      session.lastSeen = Date.now()
      sendJson(res, 200, { known: true, away: state.away, commands: [] })
    }, POLL_HOLD_MS)
    session.pollWaiter = { res, timer }
    req.on('close', () => {
      if (session.pollWaiter?.res === res) {
        clearTimeout(timer)
        session.pollWaiter = null
      }
    })
    return
  }

  // Held open until the phone decides a permission prompt, or the hold runs out.
  if (req.method === 'GET' && url.pathname === '/mod/decision') {
    const session = sessions.get(url.searchParams.get('session') ?? '')
    const id = url.searchParams.get('id') ?? ''
    if (!session) return sendJson(res, 200, { decision: null, away: false })
    session.lastSeen = Date.now()
    const answer = () => {
      const decision = session.decisions.get(id) ?? null
      if (decision) session.decisions.delete(id)
      sendJson(res, 200, { decision, away: state.away })
    }
    if (session.decisions.has(id) || !state.away) return answer()
    const timer = setTimeout(() => {
      session.decisionWaiters.delete(id)
      answer()
    }, POLL_HOLD_MS)
    session.decisionWaiters.set(id, () => {
      clearTimeout(timer)
      session.decisionWaiters.delete(id)
      answer()
    })
    req.on('close', () => {
      clearTimeout(timer)
      session.decisionWaiters.delete(id)
    })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

// ---- the phone's side
async function handleApi(req, res, url) {
  if (!isAllowedViewer(req, url)) return sendJson(res, 403, { error: 'not allowed' })
  if (req.method === 'POST' && !isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site' })

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    scanHistory()
    const list = [...sessions.values()]
      .filter(s => !s.isArchive && (s.events.length > 0 || Date.now() - s.lastSeen < ONLINE_WINDOW_MS))
      .map(summaryOf)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return sendJson(res, 200, { sessions: list, away: state.away })
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    const live = new Set([...sessions.values()].filter(s => !s.isArchive).map(s => s.id))
    return sendJson(res, 200, { chats: scanHistory().chats.filter(c => !live.has(c.id)) })
  }

  if (req.method === 'POST' && url.pathname === '/api/away') {
    const body = await readBody(req)
    state.away = body.on === true
    saveState()
    for (const session of sessions.values()) {
      pushCommand(session, { type: 'away', on: state.away })
      for (const wake of [...session.decisionWaiters.values()]) wake()
      broadcast(session, { type: 'status', summary: summaryOf(session) })
    }
    return sendJson(res, 200, { away: state.away })
  }

  if (req.method === 'GET' && url.pathname === '/api/push/key') return sendJson(res, 200, { key: vapid.publicKey })
  if (req.method === 'GET' && url.pathname === '/api/push/latest') return sendJson(res, 200, lastNotice ?? {})
  if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
    const body = await readBody(req)
    let endpoint
    try {
      endpoint = new URL(String(body.endpoint))
    } catch {
      return sendJson(res, 400, { error: 'bad endpoint' })
    }
    if (endpoint.protocol !== 'https:' || !PUSH_HOSTS.test(endpoint.hostname)) {
      return sendJson(res, 400, { error: 'unknown push service' })
    }
    if (!state.subscriptions.includes(endpoint.href)) {
      state.subscriptions = [...state.subscriptions, endpoint.href].slice(-10)
      saveState()
    }
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/push/test') {
    const session = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (session) notify(session, 'Claude Remote', 'Notifications are working.')
    return sendJson(res, 200, { ok: true, subscriptions: state.subscriptions.length })
  }

  const match = /^\/api\/sessions\/([^/]+)\/(stream|send|answer|abort|file|upload|permit|meta|config)$/.exec(url.pathname)
  if (!match) return sendJson(res, 404, { error: 'not found' })
  const session = sessions.get(decodeURIComponent(match[1])) ?? loadArchive(decodeURIComponent(match[1]))
  if (!session) return sendJson(res, 404, { error: 'no such session' })
  const action = match[2]

  if (req.method === 'GET' && action === 'stream') {
    const after = Number(url.searchParams.get('after') ?? 0)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    const write = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
    write({ type: 'hello', summary: summaryOf(session) })
    for (const event of session.events) if (event.seq > after) write(event)
    write({ type: 'caught_up', summary: summaryOf(session) })
    if (session.live) write(session.live)
    session.streams.add(res)
    const beat = setInterval(() => write({ type: 'status', summary: summaryOf(session) }), 15_000)
    req.on('close', () => {
      clearInterval(beat)
      session.streams.delete(res)
    })
    return
  }

  if (req.method === 'GET' && action === 'meta') {
    pushCommand(session, { type: 'refresh' })
    return sendJson(res, 200, { ...session.meta, commands: session.meta.commands ?? [], config: session.meta.config ?? [] })
  }

  // Images a message points at, read from the session's folder on this machine.
  if (req.method === 'GET' && action === 'file') {
    const asked = (url.searchParams.get('path') ?? '').replace(/^file:\/\//, '')
    const type = IMAGE_TYPES[extname(asked).toLowerCase()]
    if (!asked || !type) return sendJson(res, 400, { error: 'not an image' })
    const path = isAbsolute(asked) ? asked : resolve(session.meta.cwd ?? '/', asked)
    let size
    try {
      size = statSync(path).size
    } catch {
      return sendJson(res, 404, { error: 'no such file' })
    }
    if (size > MAX_IMAGE_BYTES) return sendJson(res, 413, { error: 'image too large' })
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'private, max-age=300',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    })
    return res.end(readFileSync(path))
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })

  if (action === 'upload') {
    const data = await readRaw(req, MAX_UPLOAD_BYTES)
    if (data.length === 0) return sendJson(res, 400, { error: 'empty file' })
    const name = basename(url.searchParams.get('name') ?? 'file').replace(/[^\w.\- ]/g, '_').slice(-100) || 'file'
    const dir = join(UPLOAD_DIR, safeId(session.id))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${Date.now().toString(36)}-${name}`)
    writeFileSync(path, data, { mode: 0o600 })
    return sendJson(res, 200, { path, name, size: data.length })
  }

  const body = await readBody(req)

  if (action === 'send') {
    let text = typeof body.text === 'string' ? body.text.trim() : ''
    const files = (Array.isArray(body.files) ? body.files : []).filter(
      f => typeof f === 'string' && resolve(f).startsWith(`${UPLOAD_DIR}/`) && existsSync(f),
    )
    if (!text && files.length === 0) return sendJson(res, 400, { error: 'empty message' })
    const slash = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text)
    if (slash && files.length === 0 && (session.meta.commands ?? []).some(c => c.name === slash[1])) {
      pushCommand(session, { type: 'command', name: slash[1], args: slash[2] ?? '' })
      return sendJson(res, 200, { ok: true, text, how: 'command' })
    }
    if (files.length > 0) {
      text = `${text || 'See the attached files.'}\n\n${ATTACHED}\n${files.map(f => `- ${f}`).join('\n')}`
    }
    // While a turn runs the message joins it; otherwise it starts a turn.
    const isInterjection = session.isBusy && body.wait !== true
    pushCommand(session, { type: 'prompt', text, interject: isInterjection })
    return sendJson(res, 200, { ok: true, text, how: isInterjection ? 'interject' : session.isBusy ? 'queued' : 'sent' })
  }
  if (action === 'answer') {
    if (typeof body.toolUseId !== 'string' || body.answers === null || typeof body.answers !== 'object') {
      return sendJson(res, 400, { error: 'bad answer' })
    }
    pushCommand(session, { type: 'answer', toolUseId: body.toolUseId, answers: body.answers })
    return sendJson(res, 200, { ok: true })
  }
  if (action === 'permit') {
    if (typeof body.id !== 'string' || (body.decision !== 'allow' && body.decision !== 'deny')) {
      return sendJson(res, 400, { error: 'bad decision' })
    }
    session.decisions.set(body.id, body.decision)
    session.decisionWaiters.get(body.id)?.()
    return sendJson(res, 200, { ok: true })
  }
  if (action === 'config') {
    if (typeof body.key !== 'string') return sendJson(res, 400, { error: 'bad setting' })
    pushCommand(session, { type: 'config', key: body.key, value: body.value })
    return sendJson(res, 200, { ok: true })
  }
  if (action === 'abort') {
    pushCommand(session, { type: 'abort' })
    return sendJson(res, 200, { ok: true })
  }
  sendJson(res, 404, { error: 'not found' })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true })
    if (url.pathname.startsWith('/mod/')) return await handleMod(req, res, url)
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    const file = STATIC[url.pathname]
    if (req.method === 'GET' && file && existsSync(join(PUBLIC_DIR, file[0]))) {
      const headers = { 'content-type': file[1], 'cache-control': 'no-cache' }
      // A pairing address leaves its key behind as a cookie, so the page can drop it from view.
      if (url.pathname === '/' && sameText(url.searchParams.get('key') ?? '', PAIR_KEY)) {
        headers['set-cookie'] = `cr_key=${PAIR_KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`
      }
      res.writeHead(200, headers)
      return res.end(readFileSync(join(PUBLIC_DIR, file[0])))
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, 400, { error: String(error?.message ?? error) })
  }
})

server.on('error', error => {
  // Another copy already holds the port: that one serves, this one leaves.
  if (error.code === 'EADDRINUSE') process.exit(0)
  throw error
})
server.listen(PORT, net.host, () => {
  console.log(`claude-remote (${net.mode}) listening on http://${net.host}:${PORT}`)
  console.log(net.mode === 'tailscale' ? `phone: ${net.tailnetUrl} for ${[...net.allowed].join(', ')}` : `phone: ${phoneUrl().replace(PAIR_KEY, '<pairing key>')}`)
})
