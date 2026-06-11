import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf-8')

describe('application routes', () => {
  const app = () => src('./App.tsx')

  it('keeps heavy pages lazy-loaded', () => {
    const source = app()

    for (const page of ['MapView', 'LiveMap', 'Analytics', 'NodePage', 'Packets']) {
      expect(source).toContain(`const ${page}`)
      expect(source).toContain(`lazy(() => import('./pages/${page}'))`)
    }
  })

  it('registers core deep-link routes', () => {
    const source = app()

    for (const route of [
      'path="nodes/:pubkey"',
      'path="packets/:hash/trace"',
      'path="channels/:hash"',
      'path="analytics/:tab"',
      'path="*"',
    ]) {
      expect(source).toContain(route)
    }
  })
})
