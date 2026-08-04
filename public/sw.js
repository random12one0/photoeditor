/*
 * Offline shell.
 *
 * The app is entirely client-side, so once the shell is cached it works with no
 * network at all — which matters when you're stood in a driveway with one bar,
 * and it's the difference between a website and something that behaves like an
 * installed app.
 *
 * Photos are never cached here. They live in IndexedDB, they're large, and the
 * Cache API is the wrong place for hundreds of megabytes of someone's camera
 * roll.
 */

const CACHE = 'unbklok-v1'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Navigations fall back to the cached shell so a reload works offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html').then((r) => r ?? Response.error())),
    )
    return
  }

  // Static assets are content-hashed by the build, so cache-first is safe and
  // makes a cold start on a bad connection instant.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(request, copy))
          }
          return res
        }),
    ),
  )
})
