// Fails the build when the app-shell (entry) chunk — downloaded before the first
// paint of every page — grows past its budget. Guards against regressions like
// a namespace import of a large package (`import * as …`) silently landing in
// the shell, which is how ~450 KB of flags + translations once got there.
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY_BUDGET_KB = 500

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const html = readFileSync(resolve(dist, 'index.html'), 'utf-8')
const entries = [...html.matchAll(/<script[^>]+type="module"[^>]+src="\/?([^"]+\.js)"/g)].map(m => m[1])
if (entries.length === 0) {
  console.error('check-bundle-size: no module entry script found in dist/index.html')
  process.exit(1)
}
let failed = false
for (const file of entries) {
  const kb = statSync(resolve(dist, file)).size / 1024
  const ok = kb <= ENTRY_BUDGET_KB
  console.log(`${ok ? '✓' : '✗'} entry ${file}: ${kb.toFixed(1)} KB (budget ${ENTRY_BUDGET_KB} KB)`)
  if (!ok) failed = true
}
if (failed) {
  console.error('Entry chunk over budget — lazy-load the new dependency or raise ENTRY_BUDGET_KB deliberately.')
  process.exit(1)
}
