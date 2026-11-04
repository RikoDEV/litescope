import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Packet } from '../types'
import { applyPacketUpdates } from './packets'
import { flagUrl } from './flags'

const pkt = (id: number, obsCount = 1): Packet => ({
  id, hash: `h${id}`, firstSeen: '2026-01-01T00:00:00Z', routeType: 1, payloadType: 4, obsCount, maxHops: 0,
} as Packet)

describe('applyPacketUpdates', () => {
  it('patches matching packets and keeps untouched ones by reference', () => {
    const list = [pkt(1), pkt(2), pkt(3)]
    const out = applyPacketUpdates(list, [
      { id: 2, hash: 'h2', obsCount: 4, maxHops: 2, bestPath: ['AB', 'CD'] },
      { id: 2, hash: 'h2', obsCount: 5, maxHops: 3 }, // later update for the same packet wins
    ])
    expect(out).not.toBe(list)
    expect(out[0]).toBe(list[0])
    expect(out[2]).toBe(list[2])
    expect(out[1]).toMatchObject({ obsCount: 5, maxHops: 3, bestPath: ['AB', 'CD'] })
  })

  it('returns the same array when nothing matches (lets React bail out)', () => {
    const list = [pkt(1)]
    expect(applyPacketUpdates(list, [{ id: 9, hash: 'h9', obsCount: 2, maxHops: 1 }])).toBe(list)
    expect(applyPacketUpdates(list, [])).toBe(list)
  })
})

describe('flag assets', () => {
  it('maps country codes to emitted SVG URLs instead of bundled components', () => {
    expect(flagUrl('PL')).toMatch(/PL\.svg/)
    expect(flagUrl('pl')).toBe(flagUrl('PL'))
    expect(flagUrl('ZZ')).toBeUndefined()
  })

  it('does not namespace-import the flag component library into the app shell', () => {
    const src = readFileSync(fileURLToPath(new URL('./flags.ts', import.meta.url)), 'utf-8')
    expect(src).not.toMatch(/^import .* from 'country-flag-icons\/react/m)
    expect(src).toContain('no-inline')
  })
})

describe('bundle splitting contracts', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf-8')

  it('bundles only English; other locales are dynamic imports', () => {
    const i18n = read('../i18n.ts')
    expect(i18n).toContain("import en from './locales/en'")
    for (const code of ['fr', 'de', 'nl', 'es', 'it', 'cs', 'sk', 'pl', 'uk', 'ru']) {
      expect(i18n).toContain(`import('./locales/${code}')`)
      expect(i18n).not.toContain(`from './locales/${code}'`)
    }
  })

  it('keeps recharts off the landing page', () => {
    expect(read('../pages/Home.tsx')).not.toContain("from 'recharts'")
  })

  it('every nav route has a prefetch entry using the same module as App.tsx', () => {
    const prefetch = read('./prefetch.ts')
    const app = read('../App.tsx')
    for (const page of ['Home', 'Packets', 'MapView', 'LiveMap', 'Nodes', 'Channels', 'Observers', 'Analytics', 'Decoder']) {
      expect(prefetch).toContain(`import('../pages/${page}')`)
      expect(app).toContain(`import('./pages/${page}')`)
    }
  })
})
