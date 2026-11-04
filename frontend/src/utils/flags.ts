import React from 'react'

// Flag SVGs are referenced by URL instead of bundled as React components: the
// previous `import * as … from 'country-flag-icons/react/3x2'` pulled every
// country's flag (~230 KB) into the entry chunk just to draw a few of them.
// `eager` + `?no-inline` keeps only a code → hashed-URL map in the bundle (each
// SVG is emitted as its own small, immutable-cached file fetched on first use);
// without `no-inline`, Vite would base64-inline these <4 KB files right back.
const FLAG_URLS = import.meta.glob<string>('/node_modules/country-flag-icons/3x2/*.svg', {
  eager: true, query: '?no-inline', import: 'default',
})

const URL_BY_CC = new Map<string, string>()
for (const [path, url] of Object.entries(FLAG_URLS)) {
  const cc = path.slice(path.lastIndexOf('/') + 1, -'.svg'.length)
  URL_BY_CC.set(cc.toUpperCase(), url)
}

/** URL of the 3:2 flag SVG for an ISO 3166-1 alpha-2 code, or undefined. */
export function flagUrl(cc: string): string | undefined {
  return URL_BY_CC.get(cc.toUpperCase())
}

export function isIataCode(iata: string | null | undefined): boolean {
  return !!iata && /^[A-Za-z]{3}$/.test(iata)
}

export function renderFlag(cc: string, size: number, style?: React.CSSProperties) {
  const src = flagUrl(cc)
  if (!src) return null
  return React.createElement('img', {
    src, alt: '', 'aria-hidden': true, loading: 'lazy', decoding: 'async', draggable: false,
    width: Math.round(size * 1.33), height: size,
    style: { width: Math.round(size * 1.33), height: size, display: 'inline', verticalAlign: 'middle', borderRadius: 2, flexShrink: 0, ...style },
  })
}

/** Flag for a raw ISO 3166-1 alpha-2 country code (e.g. "GB", "PL"). */
export function FlagByCC({ cc, size = 16, style }: { cc: string; size?: number; style?: React.CSSProperties }) {
  return renderFlag(cc, size, style)
}
