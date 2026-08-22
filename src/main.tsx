import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/*
 * No offline-shell service worker here anymore. It existed for the hosted
 * browser version ("stood in a driveway with one bar" -- see the old sw.js),
 * where the app and its data lived on someone else's server and losing
 * signal was real. That's not this deployment: the frontend and the API are
 * served by the same local process, on the same machine, always -- there is
 * no "offline" case to shell for, and a cache-first service worker is now
 * only a liability. It was a real, confirmed source of confusing behaviour
 * across a rebuild: caches.match-first on navigation and static assets means
 * a stale cached index.html can keep pointing at a JS bundle filename that a
 * newer build already deleted, so the app that loads doesn't match the code
 * on disk. If a previous visit ever registered one, unregistering here
 * cleans that up rather than leaving an old install shadowing new builds.
 */
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
