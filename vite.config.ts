import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * A build identifier the app can show on screen.
 *
 * This exists because of a question that could not be answered from a
 * description: "I don't see much change between when we first started and now."
 * A stale cached build and a genuinely broken feature look identical from the
 * outside, and guessing between them wasted a round. Now the version is on the
 * screen and can be read back.
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
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
})
