import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * A build identifier the app can show on screen.
 *
 * This exists because of a question that could not be answered from a
 * description: "I don't see much change between when we first started and now."
 * A stale cached build and a genuinely broken feature look identical from the
 * outside, and guessing between them wasted a round.
 *
 * Two identifiers, because they answer different questions. The version number
 * from package.json is the one to read out loud — short, ordered, and obviously
 * newer or older than another. The date and commit below it are for pinning
 * down exactly which code is running when that matters.
 */
function buildId(): string {
  let sha = 'nogit'
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    /* Not a checkout — a tarball build, say. The date alone still helps. */
  }
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )} ${sha}`
}

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  server: {
    // Only used by `npm run dev` -- the shipped launcher serves the built
    // frontend from the same FastAPI process the API lives on, so there's
    // no cross-origin request to proxy there.
    proxy: {
      '/api': 'http://127.0.0.1:8420',
    },
  },
})
