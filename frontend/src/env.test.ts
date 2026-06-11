import { afterEach, describe, expect, it, vi } from 'vitest'

const loadEnv = async (runtimeEnv?: Record<string, string>) => {
  vi.resetModules()
  vi.stubGlobal('window', { __ENV__: runtimeEnv })
  return import('./env')
}

describe('getEnv', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prefers runtime window.__ENV__ values', async () => {
    const { getEnv } = await loadEnv({ VITE_API_URL: 'https://runtime.example' })

    expect(getEnv('VITE_API_URL')).toBe('https://runtime.example')
  })

  it('returns an empty string for unknown values', async () => {
    const { getEnv } = await loadEnv({})

    expect(getEnv('MISSING_VALUE')).toBe('')
  })
})
