import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jsonResponse = (body: unknown) => Promise.resolve({
  ok: true,
  json: () => Promise.resolve(body),
} as Response)

const loadApi = async (base = 'https://api.example') => {
  vi.resetModules()
  vi.stubGlobal('window', { __ENV__: { VITE_API_URL: base } })
  const fetchMock = vi.fn(() => jsonResponse({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  const { api } = await import('./api')
  return { api, fetchMock }
}

describe('api service', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('prefixes requests with the runtime API base URL', async () => {
    const { api, fetchMock } = await loadApi('https://litescope.example')

    await api.packets(25, 50)

    expect(fetchMock).toHaveBeenCalledWith('https://litescope.example/api/packets?limit=25&offset=50')
  })

  it('serializes packet filters before pagination', async () => {
    const { api, fetchMock } = await loadApi('/base')

    await api.packets(100, 200, {
      search: '  relay  ',
      payloadTypes: [4, 2],
      routeType: 1,
      regions: ['WAW', 'LUZ'],
      lock: true,
      minObs: 3,
      sinceMs: 1710000000123.9,
      sort: 'obsCount',
      dir: 'asc',
    })

    expect(fetchMock).toHaveBeenCalledWith('/base/api/packets?limit=100&offset=200&search=relay&types=4%2C2&routeType=1&regions=WAW%2CLUZ&lock=1&minObs=3&sinceMs=1710000000123&sort=obsCount&dir=asc')
  })

  it('URL-encodes route parameters', async () => {
    const { api, fetchMock } = await loadApi()

    await api.node('aa/bb cc')
    await api.packet('hash/slash')

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.example/api/nodes/aa%2Fbb%20cc')
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.example/api/packets/hash%2Fslash')
  })

  it('serializes shared analytics filters', async () => {
    const { api, fetchMock } = await loadApi('/base')

    await api.analyticsActivity(12, {
      hours: 6,
      regions: ['WAW', 'LUZ'],
      countries: ['PL'],
      lock: true,
    })

    expect(fetchMock).toHaveBeenCalledWith('/base/api/analytics/activity?hours=6&regions=WAW%2CLUZ&countries=PL&lock=1')
  })

  it('posts decoder requests as JSON', async () => {
    const { api, fetchMock } = await loadApi('/base')

    await api.decodePacket('deadbeef', { Public: 'key' })

    expect(fetchMock).toHaveBeenCalledWith('/base/api/decode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hex: 'deadbeef', channelKeys: { Public: 'key' } }),
    })
  })

  it('throws on non-2xx responses', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { __ENV__: { VITE_API_URL: '' } })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response)))
    const { api } = await import('./api')

    await expect(api.nodes()).rejects.toThrow('404 Not Found')
  })
})
