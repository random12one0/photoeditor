/**
 * Inline the built app into one self-contained HTML file.
 *
 * The whole thing is client-side, so there's nothing stopping it being a single
 * file — which makes it openable straight off disk, e-mailable, and hostable
 * anywhere that serves one page, with no build step on the far end.
 *
 * Run:  npm run build:single   (after npm run build)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const out = join(root, 'dist-single')

const html = readFileSync(join(dist, 'index.html'), 'utf8')
const cssHrefs = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1])
const jsHrefs = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])

if (!jsHrefs.length) {
  console.error('No module script found in dist/index.html — run `npm run build` first.')
  process.exit(1)
}

const read = (href) => readFileSync(join(dist, href.replace(/^\.\//, '')), 'utf8')
const css = cssHrefs.map(read).join('\n')
// A literal </script> inside a JS string would close the tag early.
const js = jsHrefs.map(read).join('\n').replace(/<\/script/g, '<\\/script')

/* Lifted out of the built index.html rather than repeated here. This file had
   its own copy of the title and it silently kept the old name through a rename
   — a second source of truth is a second thing to forget. */
const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'Before &amp; After'

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0c0c0e" />
    <title>${title}</title>
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
${js}
    </script>
  </body>
</html>
`

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'index.html'), page)
console.log(`dist-single/index.html  ${(page.length / 1024).toFixed(0)} KB`)
