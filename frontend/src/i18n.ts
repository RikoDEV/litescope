import i18n, { type BackendModule, type ResourceKey } from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en'

export const LANGUAGES = [
  { code: 'en', label: 'English',    cc: 'GB' },
  { code: 'fr', label: 'Français',   cc: 'FR' },
  { code: 'de', label: 'Deutsch',    cc: 'DE' },
  { code: 'nl', label: 'Nederlands', cc: 'NL' },
  { code: 'es', label: 'Español',    cc: 'ES' },
  { code: 'it', label: 'Italiano',   cc: 'IT' },
  { code: 'cs', label: 'Čeština',    cc: 'CZ' },
  { code: 'sk', label: 'Slovenčina', cc: 'SK' },
  { code: 'pl', label: 'Polski',     cc: 'PL' },
  { code: 'uk', label: 'Українська', cc: 'UA' },
  { code: 'ru', label: 'Русский',    cc: 'RU' },
  { code: 'pt', label: 'Português',  cc: 'BR' },
  { code: 'sv', label: 'Svenska',    cc: 'SE' },
  { code: 'fi', label: 'Suomi',      cc: 'FI' },
  { code: 'hu', label: 'Magyar',     cc: 'HU' },
  { code: 'ro', label: 'Română',     cc: 'RO' },
]

// Only English (the fallback) is bundled into the entry chunk. Every other
// language is its own chunk, fetched once on demand — previously all 11 were
// inlined into the app shell (~210 KB) though a visitor only ever reads one.
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  fr: () => import('./locales/fr'),
  de: () => import('./locales/de'),
  nl: () => import('./locales/nl'),
  es: () => import('./locales/es'),
  it: () => import('./locales/it'),
  cs: () => import('./locales/cs'),
  sk: () => import('./locales/sk'),
  pl: () => import('./locales/pl'),
  uk: () => import('./locales/uk'),
  ru: () => import('./locales/ru'),
  pt: () => import('./locales/pt'),
  sv: () => import('./locales/sv'),
  fi: () => import('./locales/fi'),
  hu: () => import('./locales/hu'),
  ro: () => import('./locales/ro'),
}

const lazyLocales: BackendModule = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    const load = LOADERS[language]
    if (!load) { callback(null, language === 'en' ? en : {}); return }
    load().then(m => callback(null, m.default as ResourceKey), err => callback(err as Error, null))
  },
}

/**
 * Resolves once the detected language's translations are loaded. main.tsx
 * awaits it before the first render so a non-English visitor never sees an
 * English flash. Later switches (i18n.changeLanguage) load the new language
 * before applying it, so they don't flash either.
 */
export const i18nReady = i18n
  .use(lazyLocales)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    fallbackLng: 'en',
    supportedLngs: ['en', 'fr', 'de', 'nl', 'es', 'it', 'cs', 'sk', 'pl', 'uk', 'ru', 'pt', 'sv', 'fi', 'hu', 'ro'],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'litescope-lang',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    // Never suspend the tree on a missing bundle: English (always loaded)
    // stands in until the requested language arrives.
    react: { useSuspense: false },
  })

export default i18n
