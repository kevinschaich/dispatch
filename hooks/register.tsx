import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { qrLines, qrSvg } from './qr'

const DEFAULT_PORT = '7830'
const MAX_TEXT = 6000
const MAX_IMAGE_CHARS = 8_000_000
const DELTA_EVERY_MS = 350
const RETRY_MS = 2500
const PERMISSION_ROUNDS = 70
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
// Tools whose dialog only the person at the desktop can settle.
const PERSON_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'])
const INTERJECTION = 'The user sent this message from their phone while you were working:\n\n'

type Out = { type: string; [field: string]: unknown }
type Block = { type: string; [field: string]: unknown }
type Answers = Record<string, string>
type Command =
  | { type: 'prompt'; text: string; interject?: boolean }
  | { type: 'command'; name: string; args: string }
  | { type: 'config'; key: string; value: boolean | string | number }
  | { type: 'answer'; toolUseId: string; answers: Answers }
  | { type: 'away'; on: boolean }
  | { type: 'abort' }
  | { type: 'refresh' }

const clip = (text: string, max = MAX_TEXT): string =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text

const clipDeep = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return clip(value, 4000)
  if (value === null || typeof value !== 'object' || depth > 4) return value
  if (Array.isArray(value)) return value.slice(0, 50).map(v => clipDeep(v, depth + 1))

  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, clipDeep(v, depth + 1)]),
  )
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((b: Block) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

const imagesOf = (content: unknown): { mediaType: string; data: string }[] => {
  if (!Array.isArray(content)) return []
  const images: { mediaType: string; data: string }[] = []
  for (const b of content as Block[]) {
    const source = b.type === 'image' ? (b.source as Record<string, unknown> | undefined) : undefined
    if (
      source?.type === 'base64' &&
      typeof source.data === 'string' &&
      typeof source.media_type === 'string' &&
      source.data.length < MAX_IMAGE_CHARS &&
      images.length < 4
    ) {
      images.push({ mediaType: source.media_type, data: source.data })
    }
  }

  return images
}

const summaryOf = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['description', 'command', 'file_path', 'path', 'url', 'pattern', 'query', 'prompt']) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return clip(value, 200)
  }

  return ''
}

let token: string | undefined
let sessionId = ''
let queue: Out[] = []
let isFlushing = false
let isActive = true
let isAway = false
let downUntil = 0
let mainTurnId: string | undefined
let remoteUrl = ''
let base = ''
let hasTriedStart = false
// Set while this session is starting: only then may it show the QR code unasked.
let isStarting = false
let lastUserText = ''
let lastUserAt = 0
// Mid-turn messages not yet carried by a request of the running turn.
let pendingNotes: string[] = []
const hiddenPrompts = new Set<string>()
const pendingAnswers = new Map<string, (answers: Answers) => void>()

async function call(
  $: EngineInterface,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (token === undefined) {
    const home = await $.env.get('HOME')
    const raw = await $.fs.read(`${home}/.dispatch/token`)
    if (typeof raw !== 'string') throw new Error('no token')
    token = raw.trim()
  }
  if (base === '') base = `http://127.0.0.1:${(await $.env.get('DISPATCH_PORT')) ?? DEFAULT_PORT}`
  const res = await $.http.fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ ...body, instance: INSTANCE }) }),
  })
  if (res.status === 401) token = undefined
  if (!res.ok) throw new Error(`relay answered ${res.status}`)
  const answer = JSON.parse(res.text) as Record<string, unknown>
  if (answer.standby === true) isActive = false
  if (typeof answer.away === 'boolean') isAway = answer.away

  return answer
}

async function flush($: EngineInterface): Promise<void> {
  if (isFlushing) return
  isFlushing = true
  try {
    if (sessionId === '') sessionId = await $.session.id()
    while (queue.length > 0) {
      const batch = queue
      queue = []
      await call($, '/mod/events', { session: sessionId, events: batch })
    }
  } catch {
    // The relay is down: drop what is queued and stay quiet for a while.
    queue = []
    downUntil = Date.now() + RETRY_MS
  } finally {
    isFlushing = false
  }
}

function emit($: EngineInterface, events: Out[]): void {
  if (!isActive || events.length === 0 || Date.now() < downUntil) return
  for (const event of events) {
    const last = queue[queue.length - 1]
    if (event.type === 'delta' && last?.type === 'delta') queue[queue.length - 1] = event
    else queue.push(event)
  }
  void flush($)
}

async function backfill($: EngineInterface): Promise<Out[]> {
  const read = await $.session.messages({ last: 300 })
  const rows = Array.isArray(read) ? (read as SessionMessage[]) : []
  const events: Out[] = []
  for (const row of rows) {
    if (row.role === 'user') {
      const text = row.text.trim()
      if (text !== '' && !text.startsWith('<') && !(row.toolResults?.length ?? 0)) {
        events.push({ type: 'user', text: clip(text) })
      }
      continue
    }
    if (row.text.trim() !== '') events.push({ type: 'assistant', text: row.text })
    for (const use of row.toolUses) {
      events.push({
        type: 'tool_use',
        id: use.tool_use_id,
        name: use.tool,
        input: clipDeep(use.input),
        done: true,
        result: clip(use.text ?? ''),
        isError: use.isError === true,
      })
    }
  }

  return events
}

// A prompt can reach us twice (its row and its turn's start) or only once,
// when a plugin above sends the row past this one: show it once.
function userEvent(text: string, uuid?: string): Out[] {
  if (hiddenPrompts.delete(text)) return []
  const now = Date.now()
  if (text === lastUserText && now - lastUserAt < 15_000) return []
  lastUserText = text
  lastUserAt = now

  return [{ type: 'user', text: clip(text), ...(uuid === undefined ? {} : { uuid }) }]
}

async function metaOf($: EngineInterface, isFull: boolean): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    cwd: await $.session.cwd(),
    model: await $.session.model(),
  }
  try {
    const usage = await $.session.usage()
    meta.usage = {
      percent: usage.context.percent,
      tokens: usage.context.tokens,
      window: usage.context.window,
      costUsd: usage.cost?.usd,
    }
  } catch {
    // Figures are optional.
  }
  if (!isFull) return meta
  try {
    meta.commands = (await $.command.list()).map(c => ({
      name: c.name,
      description: clip(c.description, 140),
    }))
    meta.config = (await $.config.list())
      .filter(row => !row.isLocked && ((row.options?.length ?? 0) > 0 || typeof row.value === 'boolean'))
      .map(row => ({
        key: row.key,
        label: row.label,
        description: row.description === undefined ? undefined : clip(row.description, 200),
        value: row.value,
        options: row.options,
      }))
  } catch {
    // Lists are optional.
  }
  // What the desktop's session panel shows: environment, context, agents.
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    meta.context = (usage.context.breakdown?.categories ?? [])
      .filter(c => c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
    meta.rateLimits = usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed }))
  } catch {
    // Optional.
  }
  try {
    const repo = await $.session.repo()
    meta.repo = repo === null ? null : { root: repo.root, remote: repo.remote }
  } catch {
    // Optional.
  }
  try {
    const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: String(meta.cwd) })
    const out = (git as { stdout?: string }).stdout
    meta.branch = git.exitCode === 0 && typeof out === 'string' ? out.trim() : ''
  } catch {
    // Optional.
  }
  try {
    meta.agents = (await $.agent.list()).map(a => ({ description: a.description, type: a.type, status: a.status }))
  } catch {
    // Optional.
  }
  try {
    meta.version = (await $.session.version()).version
  } catch {
    // Optional.
  }
  try {
    const servers = new Set<string>()
    for (const tool of await $.tool.list()) {
      const server = /^mcp__(.+?)__/.exec(tool.name)?.[1]
      if (server !== undefined) servers.add(server)
    }
    meta.servers = [...servers]
  } catch {
    // Optional.
  }

  return meta
}

async function refreshMeta($: EngineInterface, isFull: boolean): Promise<void> {
  if (!isActive) return
  try {
    await call($, '/mod/events', { session: sessionId, meta: await metaOf($, isFull), events: [] })
  } catch {
    // The relay is down; the next turn tries again.
  }
}

// Starts the relay that ships in this plugin, detached, so it outlives the
// session. A copy that finds the port taken exits at once.
async function startRelay($: EngineInterface): Promise<void> {
  if (hasTriedStart) return
  hasTriedStart = true
  const { packageManagers } = await $.session.machine()
  const runtime = packageManagers.includes('node') ? 'node' : packageManagers.includes('bun') ? 'bun' : undefined
  if (runtime === undefined) {
    $.ui.toast('Dispatch needs Node.js 24 or newer (or Bun) on the PATH to start its relay.', { timeoutMs: 12000 })

    return
  }
  await $.process.run(
    [
      '/bin/sh',
      '-c',
      'mkdir -p "$HOME/.dispatch" && (nohup "$0" "$1" >> "$HOME/.dispatch/server.log" 2>&1 < /dev/null &)',
      runtime,
      `${$.plugin.root}/server/server.mjs`,
    ],
    { timeoutMs: 15000 },
  )
}

// The first time this address is seen, the session that is starting puts the
// QR code in its chat. One that merely reconnects to the relay stays quiet, so
// the code lands where the person is: the session they just installed in or opened.
async function announce($: EngineInterface): Promise<void> {
  if (!isStarting || remoteUrl === '') return
  isStarting = false
  if ((await $.store.get('announced')) === remoteUrl) return
  await $.store.set('announced', remoteUrl)
  $.clock.after(1200, () => {
    void $.command.run({ command: 'phone' }).catch(() => {})
  })
}

async function hello($: EngineInterface): Promise<void> {
  sessionId = await $.session.id()
  isActive = true
  const answer = await call($, '/mod/hello', { session: sessionId, meta: await metaOf($, true) })
  if (typeof answer.url === 'string') remoteUrl = answer.url
  if (answer.known !== true) {
    const events = await backfill($)
    await call($, '/mod/events', { session: sessionId, reset: true, events })
  }
  downUntil = 0
  await announce($).catch(() => {})
}

// While a turn runs, the message joins it as a row the model reads at its
// next request; with no turn running it starts one.
async function deliver($: EngineInterface, text: string, isInterjection: boolean): Promise<void> {
  if (isInterjection && mainTurnId !== undefined) {
    try {
      const sent = await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text: `${INTERJECTION}${text}` }] },
      })
      if (sent.deny === undefined) {
        pendingNotes.push(text)
        emit($, userEvent(text))

        return
      }
    } catch {
      // Falls through to a prompt of its own.
    }
  }
  await $.prompt.submit({ text, asUser: true })
}

async function runCommand($: EngineInterface, name: string, args: string): Promise<void> {
  emit($, userEvent(`/${name}${args ? ` ${args}` : ''}`))
  try {
    const ran = await $.command.run({ command: name, args })
    const text = (ran as { text?: string }).text
    if (typeof text === 'string' && text.trim() !== '') emit($, [{ type: 'notice', text: clip(text, 1500) }])
  } catch (error) {
    emit($, [{ type: 'notice', text: `/${name} did not run: ${String((error as Error).message ?? error)}` }])
  }
}

async function setConfig($: EngineInterface, key: string, value: boolean | string | number): Promise<void> {
  try {
    const set = await $.config.set({ key, value })
    emit($, [{ type: 'notice', text: set.deny === undefined ? `Setting changed: ${key} = ${String(set.value)}` : `Setting not changed: ${set.deny}` }])
  } catch (error) {
    emit($, [{ type: 'notice', text: `Setting not changed: ${String((error as Error).message ?? error)}` }])
  }
  await refreshMeta($, true)
}

function run($: EngineInterface, command: Command): void {
  if (command.type === 'prompt') {
    void deliver($, command.text, command.interject === true).catch(() => {})
  } else if (command.type === 'command') {
    void runCommand($, command.name, command.args)
  } else if (command.type === 'config') {
    void setConfig($, command.key, command.value)
  } else if (command.type === 'abort') {
    if (mainTurnId !== undefined) void $.turn.abort({ turnId: mainTurnId }).catch(() => {})
  } else if (command.type === 'away') {
    isAway = command.on
  } else if (command.type === 'refresh') {
    void refreshMeta($, true)
  } else {
    pendingAnswers.get(command.toolUseId)?.(command.answers)
  }
}

async function poll($: EngineInterface): Promise<void> {
  let delay = 0
  try {
    const answer = await call(
      $,
      `/mod/poll?session=${encodeURIComponent(sessionId)}&instance=${encodeURIComponent(INSTANCE)}`,
    )
    // A newer copy of this mod owns the session now: this one goes quiet.
    if (answer.standby === true) return
    if (answer.known !== true) await hello($)
    const commands = Array.isArray(answer.commands) ? (answer.commands as Command[]) : []
    for (const command of commands) run($, command)
  } catch {
    delay = RETRY_MS
  }
  $.clock.after(delay, () => {
    void poll($)
  })
}

// Puts a permission prompt to the phone and waits inside the relay's long
// poll. Resolves undefined when away mode ends or nobody answers in time.
async function askPhone(
  $: EngineInterface,
  id: string,
  tool: string,
  input: unknown,
  reason: string | undefined,
): Promise<'allow' | 'deny' | undefined> {
  emit($, [{ type: 'permission', id, tool, summary: summaryOf(input), input: clipDeep(input), reason }])
  let decision: 'allow' | 'deny' | undefined
  try {
    for (let round = 0; round < PERMISSION_ROUNDS && decision === undefined; round++) {
      const answer = await call(
        $,
        `/mod/decision?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`,
      )
      if (answer.decision === 'allow' || answer.decision === 'deny') decision = answer.decision
      else if (answer.away !== true) break
    }
  } catch {
    // The relay went away: the desktop is asked.
  }
  emit($, [{ type: 'permission_done', id, decision: decision ?? 'desktop' }])

  return decision
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isStarting = true
    try {
      await $.command.register({
        name: 'phone',
        description: 'Show the address of this session on your phone',
      })
      await hello($)
    } catch {
      // No relay answers: start the one in this plugin; the poll loop meets it.
      await startRelay($).catch(() => {})
    }
    void poll($)

    return next(e)
  })

  on('command.run', { command: 'phone' }, async $ => {
    try {
      await hello($)
    } catch {
      return { text: 'The Dispatch relay is not running. It starts with the next session, or run `node server/cli.mjs start` in the plugin folder.' }
    }

    // The address itself is drawn below and kept out of the transcript: on a
    // local network it carries the pairing key.
    return { text: 'Dispatch is ready. Scan the QR code with your phone to open this session there.' }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'phone' } }, ($, e, next) => {
    if (remoteUrl === '' || e.props.isErrored) return next(e)
    const shown = remoteUrl.split('?')[0] ?? remoteUrl
    const note = remoteUrl.includes('?key=')
      ? `${shown} (on this network; the code carries the pairing key)`
      : `${shown} (on your tailnet)`
    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text>Dispatch: scan with your phone to open this session there.</Text>
          {qrLines(remoteUrl).map(line => (
            <Text>{line}</Text>
          ))}
          <Text dimColor>{note}</Text>
        </Box>
      )
    }
    const { Box, Text, Svg } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text>Dispatch: scan with your phone to open this session there.</Text>
        <Svg source={qrSvg(remoteUrl)} alt={`QR code for ${shown}`} width={232} height={232} />
        <Text dimColor>{note}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('session.append', ($, e, next) => {
    try {
      const { message, door, agentId, uuid } = e
      const tag = agentId === undefined ? {} : { agentId }
      const blocks = message.content as Block[]
      const events: Out[] = []
      if (door === 'queue' || message.type === 'attachment') {
        // Not rows the chat shows.
      } else if (message.type === 'assistant') {
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
            events.push({ type: 'assistant', text: b.text, uuid, ...tag })
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() !== '') {
            events.push({ type: 'thinking', text: clip(b.thinking), ...tag })
          } else if (b.type === 'tool_use') {
            events.push({ type: 'tool_use', id: b.id, name: b.name, input: clipDeep(b.input), ...tag })
          }
        }
      } else if (message.type === 'user') {
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const images = imagesOf(b.content)
            events.push({
              type: 'tool_result',
              id: b.tool_use_id,
              text: clip(textOf(b.content)),
              isError: b.is_error === true,
              ...(images.length > 0 ? { images } : {}),
              ...tag,
            })
          }
        }
        const text = textOf(blocks).trim()
        const origin = e.origin as { kind?: string; name?: string }
        const isOurs = origin.kind === 'plugin' && origin.name === $.plugin.name
        if (text !== '' && door === 'prompt' && agentId === undefined && (message.isMeta !== true || isOurs)) {
          events.push(...userEvent(text, uuid))
        } else if (text !== '' && door === 'delivery') {
          const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]
          if (summary) events.push({ type: 'notice', text: summary.trim(), ...tag })
        }
      } else if (door === 'notice') {
        const text = textOf(blocks).trim()
        if (text !== '') events.push({ type: 'notice', text: clip(text, 600), ...tag })
      }
      emit($, events)
    } catch {
      // Mirroring never stands in the way of the row.
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    const events: Out[] = []
    if (e.agentId === undefined) {
      mainTurnId = e.turnId
      const text = e.text.trim()
      if (text !== '' && !text.startsWith('<')) events.push(...userEvent(text))
    }
    events.push({ type: 'turn', state: 'start', ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
    emit($, events)

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurnId = undefined
      // A mid-turn message the turn ended without reading starts its own turn.
      const unread = pendingNotes
      pendingNotes = []
      for (const text of unread) {
        hiddenPrompts.add(text)
        void $.prompt.submit({ text, asUser: true }).catch(() => {})
      }
      void refreshMeta($, true)
    }
    emit($, [
      {
        type: 'turn',
        state: 'end',
        reason: e.reason,
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      },
    ])

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) return yield* stream

    // Notes appended before this request are carried by it.
    pendingNotes = []
    let text = ''
    let thinking = ''
    let block = -1
    let sentAt = 0
    let isDone = false
    let preparing: string | undefined
    try {
      for (;;) {
        const item = await stream.next()
        if (item.done === true) {
          isDone = true

          return item.value
        }
        const chunk = item.value
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          if (chunk.kind === 'text') {
            if (chunk.index !== block && text !== '') text += '\n\n'
            block = chunk.index
            text += chunk.text
          } else thinking += chunk.text
          if (Date.now() - sentAt > DELTA_EVERY_MS) {
            sentAt = Date.now()
            emit($, [{ type: 'delta', text, thinking: thinking.slice(-600) }])
          }
        } else if (chunk.kind === 'tool' && chunk.name !== preparing) {
          // A long tool input takes a while to arrive: say which tool is coming.
          preparing = chunk.name
          emit($, [{ type: 'delta', text, thinking: thinking.slice(-600), tool: chunk.name }])
        }
        yield chunk
      }
    } finally {
      if (!isDone) await stream.return(undefined as never)
    }
  })

  on('agent.spawn', ($, e, next) => {
    emit($, [
      {
        type: 'agent_start',
        description: e.description,
        subagentType: e.subagentType,
        prompt: clip(e.prompt, 1500),
      },
    ])

    return next(e)
  })

  // In away mode a permission prompt goes to the phone first; with no answer,
  // or with away mode off, the desktop asks as it always does.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (
      verdict.decision !== 'ask' ||
      !isAway ||
      !isActive ||
      e.tool_use_id === undefined ||
      e.approver === undefined ||
      PERSON_ONLY.has(e.tool)
    ) {
      return verdict
    }
    const decision = await askPhone($, e.tool_use_id, e.tool, e.input, verdict.reason)
    if (decision === 'allow') return { decision: 'allow', reason: 'Approved from the phone' }
    if (decision === 'deny') return { decision: 'deny', reason: 'Denied from the phone' }

    return verdict
  }).catch(($, e, next) => next(e))

  // A question goes to the desktop's dialog and to the phone at once; the
  // first answer wins.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!isActive) return next(e)
    const toolUseId = e.tool_use_id
    emit($, [{ type: 'question', toolUseId, questions: clipDeep(e.questions) }])
    const fromPhone = new Promise<{ answers: Answers }>(resolve => {
      pendingAnswers.set(toolUseId, answers => resolve({ answers }))
    })
    const desk = next(e)
    desk.catch(() => {})
    try {
      const first = await Promise.race([desk.then(ran => ({ ran })), fromPhone])
      if ('ran' in first) {
        const answers = (first.ran.result as { answers?: Answers } | undefined)?.answers
        emit($, [{ type: 'question_done', toolUseId, answers: answers ?? {} }])

        return first.ran
      }
      emit($, [{ type: 'question_done', toolUseId, answers: first.answers }])

      return { result: { questions: e.questions, answers: first.answers } }
    } finally {
      pendingAnswers.delete(toolUseId)
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    emit($, [{ type: 'ended', reason: e.reason }])
    await flush($)

    return next(e)
  })
}
