import { useTranslation } from 'react-i18next'
import { enUS, pl, de } from 'date-fns/locale'
import type { Locale } from 'date-fns'

const LOCALES: Record<string, Locale> = { en: enUS, pl, de }

export function useDateLocale(): Locale {
  const { i18n } = useTranslation()
  return LOCALES[i18n.language] ?? LOCALES[i18n.language.split('-')[0]] ?? enUS
}
