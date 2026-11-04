import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { enUS } from 'date-fns/locale/en-US'
import type { Locale } from 'date-fns'

// date-fns locale per UI language. Only en-US is bundled; the rest are fetched
// on first use (as separate chunks) and cached, so every UI language gets
// localized relative dates without shipping 11 locales to every visitor.
const LOADERS: Record<string, () => Promise<Locale>> = {
  fr: () => import('date-fns/locale/fr').then(m => m.fr),
  de: () => import('date-fns/locale/de').then(m => m.de),
  nl: () => import('date-fns/locale/nl').then(m => m.nl),
  es: () => import('date-fns/locale/es').then(m => m.es),
  it: () => import('date-fns/locale/it').then(m => m.it),
  cs: () => import('date-fns/locale/cs').then(m => m.cs),
  sk: () => import('date-fns/locale/sk').then(m => m.sk),
  pl: () => import('date-fns/locale/pl').then(m => m.pl),
  uk: () => import('date-fns/locale/uk').then(m => m.uk),
  ru: () => import('date-fns/locale/ru').then(m => m.ru),
}

const loaded = new Map<string, Locale>([['en', enUS]])
const pending = new Map<string, Promise<Locale>>()

function baseLang(lng: string | undefined): string {
  return lng?.split('-')[0] ?? 'en'
}

function loadLocale(lang: string): Promise<Locale> {
  const hit = loaded.get(lang)
  if (hit) return Promise.resolve(hit)
  const load = LOADERS[lang]
  if (!load) return Promise.resolve(enUS)
  let p = pending.get(lang)
  if (!p) {
    p = load().then(l => { loaded.set(lang, l); return l }, () => enUS)
    pending.set(lang, p)
  }
  return p
}

export function useDateLocale(): Locale {
  const { i18n } = useTranslation()
  const lang = baseLang(i18n.language)
  const [locale, setLocale] = useState<Locale>(() => loaded.get(lang) ?? enUS)
  useEffect(() => {
    let cancelled = false
    const hit = loaded.get(lang)
    if (hit) { setLocale(hit); return }
    void loadLocale(lang).then(l => { if (!cancelled) setLocale(l) })
    return () => { cancelled = true }
  }, [lang])
  return locale
}
