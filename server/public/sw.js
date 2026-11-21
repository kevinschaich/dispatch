// Pushes arrive empty; the text is fetched from the relay, which only this
// tailnet device can reach.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let notice = {}
    try {
      notice = await (await fetch('/api/push/latest', { cache: 'no-store' })).json()
    } catch {}
    await self.registration.showNotification(notice.title || 'Dispatch', {
      body: notice.body || 'Something needs your attention.',
      tag: notice.tag,
      icon: '/icon.png',
      data: { url: notice.url || '/' },
    })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('navigate' in client) {
        await client.navigate(url).catch(() => {})
        return client.focus()
      }
    }
    return self.clients.openWindow(url)
  })())
})
