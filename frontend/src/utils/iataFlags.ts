import React from 'react'
import { IATA_CC } from './iataData'
import { renderFlag } from './flags'

// Kept apart from flags.ts so the ~28 KB IATA → country table is only loaded by
// the views that resolve observer regions, not by the app shell (Layout only
// needs FlagByCC for the language menu).

/** Returns the ISO 3166-1 alpha-2 country code for an IATA location code, or '' if unknown. */
export function iataCountry(iata: string | null | undefined): string {
  if (!iata) return ''
  return IATA_CC.get(iata.toUpperCase()) ?? ''
}

/** Flag for an IATA location code. Renders nothing for unknown codes. */
export function IataFlag({ iata, size = 16, style }: { iata: string | null | undefined; size?: number; style?: React.CSSProperties }) {
  const cc = iataCountry(iata)
  if (!cc) return null
  return renderFlag(cc, size, style)
}
