import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf-8')
const nodeMiniMapSource = (source: string) => {
  const match = /function NodeMiniMap[\s\S]*?\n}\r?\n\r?\n\/\/ ── stat card/.exec(source)
  expect(match).not.toBeNull()
  return match?.[0] ?? ''
}

describe('node detail map regressions', () => {
  const nodePage = () => src('./NodePage.tsx')
  const nodeDetailPanel = () => src('../components/NodeDetailPanel.tsx')

  it('loads Leaflet CSS in every lazy-loaded module that creates a Leaflet map', () => {
    // The node mini maps are created by utils/miniMap (reached only via import()),
    // so that module — not the pages — must carry the map stylesheets.
    const miniMap = src('../utils/miniMap.ts')
    expect(miniMap).toContain("import 'leaflet/dist/leaflet.css'")
    expect(miniMap).toContain("import 'maplibre-gl/dist/maplibre-gl.css'")
    expect(nodePage()).toContain('useMiniMap(')
    expect(nodeDetailPanel()).toContain('useMiniMap(')
  })

  it('keeps Leaflet/maplibre out of the node page and detail panel chunks', () => {
    for (const source of [nodePage(), nodeDetailPanel()]) {
      expect(source).not.toContain("from 'leaflet'")
      expect(source).not.toContain('utils/mapTiles')
    }
  })

  it('keeps the node detail mini map at a bounded responsive height', () => {
    const source = nodeMiniMapSource(nodePage())

    expect(source).toContain('height: { xs: 220, sm: 260, md: 300 }')
    expect(source).toContain('maxHeight: 320')
    expect(source).not.toContain("height: '100%'")
  })

  it('does not observe map resizes from the node detail route', () => {
    expect(nodePage()).not.toContain('ResizeObserver')
  })

  it('keeps lower content in independent columns so cards can fill below the map', () => {
    const source = nodePage()

    expect(source).toContain("gridTemplateColumns: { xs: '1fr', md: hasHeardBy && hasMap ? '1fr 1fr' : '1fr' }")
    expect(source).toContain("display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0")
  })
})
