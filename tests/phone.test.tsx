import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROW = {
  plugin: 'remote-control',
  component: 'CommandOutput',
  requestId: 'row-1',
  props: { command: 'phone', args: '', text: 'Claude Remote is ready.', isErrored: false },
} as const

// Nothing sits beneath the plugin in a test: these hooks stand for the engine
// and for a relay that answers on loopback.
const relay = (on: On, url: string): void => {
  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  on('fs.read', () => ({ value: 'token' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'model' }))
  on('clock.after', () => ({ value: undefined }))
  on('http.fetch', (_, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify(e.url.includes('/mod/hello') ? { known: true, url, mode: 'lan', away: false } : { ok: true }),
    },
  }))
}

test('the phone command draws a QR code on every surface', async ($, on) => {
  relay(on, 'http://192.168.1.20:7830/?key=abcdefghijklmnopqrstuvwxyz012345')
  const ran = (await $.command.run({ command: 'phone', args: '' } as never)) as { text?: string }
  expect(ran.text).toMatch(/Scan the QR code/)
  // The pairing key is drawn, never written into the transcript.
  expect(ran.text).not.toMatch(/key=/)

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...ROW, surface })
    expect(await ui.find({ type: 'Svg' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /192\.168\.1\.20/ }))?.text).toMatch(/pairing key/)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /█{10}/ })).toBeDefined()
  await ui.unmount()
})

test('a tailnet address is named as one', async ($, on) => {
  relay(on, 'https://box.example.ts.net/')
  await $.command.run({ command: 'phone', args: '' } as never)
  const ui = await $.ui.mount({ ...ROW, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /box\.example/ }))?.text).toMatch(/tailnet/)
  await ui.unmount()
})
