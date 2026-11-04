// Attributes the minified bytes of each large chunk to the package / source
// file they came from, using the build's sourcemaps. Run via
// `pnpm run build:analyze` (builds with sourcemaps into dist-analyze/).
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? 'dist-analyze/assets')
const minKB = Number(process.argv[3] ?? 50)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const VAL = Object.fromEntries([...B64].map((c, i) => [c, i]))

function decodeSegment(seg) {
  const out = []
  let v = 0, shift = 0
  for (const ch of seg) {
    const d = VAL[ch]
    v += (d & 31) << shift
    if (d & 32) shift += 5
    else { out.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0 }
  }
  return out
}

function owner(source) {
  const s = source.replaceAll(String.fromCharCode(92), '/') // Windows path separators
  const pkg = s.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/((@[^/]+\/)?[^/]+)/) ?? s.match(/node_modules\/((@[^/]+\/)?[^/]+)/)
  if (pkg) return pkg[1]
  const src = s.match(/src\/(.*)/)
  return src ? `src/${src[1]}` : s
}

for (const mapFile of readdirSync(dir).filter(f => f.endsWith('.js.map'))) {
  const code = readFileSync(join(dir, mapFile.slice(0, -4)), 'utf8')
  if (code.length < minKB * 1024) continue
  const map = JSON.parse(readFileSync(join(dir, mapFile), 'utf8'))
  const lines = code.split('\n')
  const sizes = {}
  let src = 0
  map.mappings.split(';').forEach((line, li) => {
    const segs = line ? line.split(',').map(decodeSegment) : []
    const text = lines[li] ?? ''
    let col = 0
    segs.forEach((s, i) => {
      col += s[0]
      if (s.length > 1) src += s[1]
      const end = i + 1 < segs.length ? col + segs[i + 1][0] : text.length
      const key = owner(map.sources[src] ?? '?')
      sizes[key] = (sizes[key] ?? 0) + (end - col)
    })
  })
  console.log(`\n== ${mapFile.slice(0, -4)} (${(code.length / 1024).toFixed(0)} KB)`)
  for (const [k, v] of Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${(v / 1024).toFixed(1).padStart(8)} KB  ${k}`)
  }
}
