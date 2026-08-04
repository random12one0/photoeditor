/**
 * Shared plumbing for the browser-driven test harnesses.
 *
 * Both bits here exist because the suites first ran only on one machine and
 * then failed on CI for reasons that had nothing to do with the app: a ten
 * second wait for the dev server is generous on a warm laptop and far too
 * short on a cold runner, and the sandbox's Chromium lives at a path that
 * doesn't exist on a GitHub runner.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'

/** The sandbox ships a browser here; elsewhere Playwright's own copy is used. */
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium'

export function launchBrowser(options = {}) {
  const executablePath = existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined
  return chromium.launch({ ...options, ...(executablePath ? { executablePath } : {}) })
}

/**
 * Start a Vite server and wait for it to answer.
 *
 * `mode: 'preview'` serves the built output; `'dev'` serves the repo, which the
 * harnesses that fetch fixtures out of /test/ need.
 */
export async function startServer(port, { mode = 'dev', timeoutMs = 120_000 } = {}) {
  /* --host 127.0.0.1 is not optional. Vite binds "localhost", which on a
     GitHub runner resolves to ::1 while the harness polls 127.0.0.1 — the
     server comes up perfectly and the poll never sees it. */
  const common = ['--port', String(port), '--strictPort', '--host', '127.0.0.1']
  const args = mode === 'preview' ? ['vite', 'preview', ...common] : ['vite', ...common]

  const proc = spawn('npx', args, { stdio: 'ignore' })

  let exited = false
  proc.on('exit', (code) => {
    exited = true
    if (code) console.error(`vite exited early with code ${code}`)
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) throw new Error(`vite (${mode}) exited before serving on ${port}`)
    try {
      const res = await fetch(base)
      if (res.ok) return { proc, base }
    } catch {
      /* not listening yet */
    }
    await sleep(300)
  }

  proc.kill('SIGTERM')
  throw new Error(`vite (${mode}) never came up on ${port} within ${timeoutMs}ms`)
}
