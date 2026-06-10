import React from 'react'
import * as FlagComponents from 'country-flag-icons/react/3x2'
import { IATA_CC } from './iataData'

/** Returns the ISO 3166-1 alpha-2 country code for an IATA location code, or '' if unknown. */
export function iataCountry(iata: string | null | undefined): string {
  if (!iata) return ''
  return IATA_CC.get(iata.toUpperCase()) ?? ''
}

export function isIataCode(iata: string | null | undefined): boolean {
  return !!iata && /^[A-Za-z]{3}$/.test(iata)
}

const FLAGS = FlagComponents as Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>>

function renderFlag(cc: string, size: number, style?: React.CSSProperties) {
  const FlagSvg = FLAGS[cc.toUpperCase()]
  if (!FlagSvg) return null
  return React.createElement(FlagSvg, {
    style: { width: Math.round(size * 1.33), height: size, display: 'inline', verticalAlign: 'middle', borderRadius: 2, flexShrink: 0, ...style },
  })
}

/** Inline SVG flag for an IATA location code. Renders nothing for unknown codes. */
export function IataFlag({ iata, size = 16, style }: { iata: string | null | undefined; size?: number; style?: React.CSSProperties }) {
  const cc = iataCountry(iata)
  if (!cc) return null
  return renderFlag(cc, size, style)
}

/** Inline SVG flag for a raw ISO 3166-1 alpha-2 country code (e.g. "GB", "PL"). */
export function FlagByCC({ cc, size = 16, style }: { cc: string; size?: number; style?: React.CSSProperties }) {
  return renderFlag(cc, size, style)
}
