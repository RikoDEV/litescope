import { afterEach, describe, expect, it, vi } from 'vitest'

const loadEnv = async (runtimeEnv?: Record<string, string>) => {
  vi.resetModules()
  vi.stubGlobal('window', { __ENV__: runtimeEnv })
  return import('./env')
}

describe('getEnv', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('prefers runtime window.__ENV__ values', async () => {
    const { getEnv } = await loadEnv({ VITE_API_URL: 'https://runtime.example' })

    expect(getEnv('VITE_API_URL')).toBe('https://runtime.example')
  })

  it('returns an empty string for unknown values', async () => {
    const { getEnv } = await loadEnv({})

    expect(getEnv('MISSING_VALUE')).toBe('')
  })

  it('waits for deferred runtime env values', async () => {
    vi.useFakeTimers()
    const { getEnv, waitForEnv } = await loadEnv({})

    const waiting = waitForEnv(
      () => Boolean(getEnv('VITE_UMAMI_URL') && getEnv('VITE_UMAMI_WEBSITE_ID')),
      1000,
      10,
    )
    setTimeout(() => {
      window.__ENV__ = {
        VITE_UMAMI_URL: 'https://analytics.example/script.js',
        VITE_UMAMI_WEBSITE_ID: 'site-1',
      }
    }, 30)

    await vi.advanceTimersByTimeAsync(30)
    await waiting

    expect(getEnv('VITE_UMAMI_URL')).toBe('https://analytics.example/script.js')
  })
})
