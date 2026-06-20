import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./MapView.tsx', import.meta.url)), 'utf-8')

describe('map label controls', () => {
  it('keeps hash-prefix and node-title labels independent', () => {
    expect(source).toContain('const [showHashLabels, setShowHashLabels] = useState(false)')
    expect(source).toContain('const [showTitleLabels, setShowTitleLabels] = useState(false)')
    expect(source).toContain("const hashLabel  = showHashLabels ? n.pubKey.slice(0, prefixBytes * 2).toUpperCase() : ''")
    expect(source).toContain("showTitleLabels ? (n.name || n.pubKey.slice(0, 8)) : ''")
    expect(source).toContain('font-weight:900;-webkit-text-stroke:0.25px currentColor')
  })

  it('uses the advertised routing-prefix byte length', () => {
    expect(source).toContain('const prefixBytes = nodeByteSizeRef.current.get(n.pubKey) ?? 1')
  })
})
