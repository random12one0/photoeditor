import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/*
 * Register the offline shell, but only where one was actually deployed.
 *
 * The app is also served as a single self-contained file in places that ship no
 * sw.js at all, and registering blind there logs a 404 to the console for a
 * feature that was never going to work. Checking first keeps that quiet.
 * Failure is never surfaced either way: without it the app still runs, it just
 * won't survive losing signal.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const url = `${import.meta.env.BASE_URL}sw.js`
    void fetch(url, { method: 'HEAD' })
      .then((res) => {
        if (res.ok) return navigator.serviceWorker.register(url)
        return undefined
      })
      .catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
