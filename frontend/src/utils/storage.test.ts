import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LS_KEYS,
  loadChannelHashNames,
  loadChannelKeys,
  saveChannelHashNames,
  saveChannelKeys,
} from './storage'

const memoryStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { map.set(key, value) }),
    removeItem: vi.fn((key: string) => { map.delete(key) }),
    clear: vi.fn(() => { map.clear() }),
  }
}

describe('storage helpers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips channel keys and hash names', () => {
    const localStorage = memoryStorage()
    vi.stubGlobal('localStorage', localStorage)

    const keys = [{ name: 'Public', key: 'abc', derived: true }]
    saveChannelKeys(keys)
    expect(loadChannelKeys()).toEqual(keys)

    saveChannelHashNames({ '59': 'Public' })
    expect(loadChannelHashNames()).toEqual({ '59': 'Public' })
  })

  it('falls back on corrupt JSON', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{bad json' })

    expect(loadChannelKeys()).toEqual([])
    expect(loadChannelHashNames()).toEqual({})
  })

  it('uses stable localStorage key names shared across pages', () => {
    expect(LS_KEYS.channelKeys).toBe('litescope-channel-keys')
    expect(LS_KEYS.channelHashNames).toBe('litescope-channel-hash-names')
  })
})
