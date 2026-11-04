import { afterEach, describe, expect, it, vi } from 'vitest'

// Exercises the lazy locale backend end to end: a visitor whose stored
// language is Polish must get Polish strings once i18nReady resolves, with
// English still bundled as the fallback.
describe('i18n lazy locales', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  const stubBrowser = (lang: string) => {
    const store: Record<string, string> = { 'litescope-lang': lang }
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    })
    vi.stubGlobal('window', { localStorage: globalThis.localStorage })
    vi.stubGlobal('navigator', { language: lang, languages: [lang] })
  }

  it('loads the detected language before resolving i18nReady', async () => {
    stubBrowser('pl')
    const { default: i18n, i18nReady } = await import('./i18n')
    const pl = (await import('./locales/pl')).default
    await i18nReady
    expect(i18n.language).toBe('pl')
    expect(i18n.t('nav.home')).toBe(pl.nav.home)
  })

  it('switches language only after its bundle is loaded', async () => {
    stubBrowser('en')
    const { default: i18n, i18nReady } = await import('./i18n')
    const de = (await import('./locales/de')).default
    await i18nReady
    expect(i18n.language).toBe('en')
    await i18n.changeLanguage('de')
    expect(i18n.t('nav.home')).toBe(de.nav.home)
  })
})
