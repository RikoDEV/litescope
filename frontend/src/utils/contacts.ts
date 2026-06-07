// Parses rich tokens embedded in channel messages:
//  • MeshCore contact-share cards: <pubKeyHex(64):type:name>
//      e.g. <6b2a0f47…b2b8252:1:riko ES Skierniewice>
//  • Location shares: "lat,lon" with ≥3 decimals e.g. 51.977430,20.060091
// The MeshCore app renders the contact card with an "add contact" button; we
// render a card with a QR-code action and a tiny map for locations.

export interface ContactShare {
  raw: string      // the full original token incl. angle brackets
  pubKey: string   // 32-byte public key, lowercase hex (64 chars)
  type: number     // advert/contact type flag
  name: string     // display name (may contain spaces)
}

export interface LocationShare {
  raw: string
  lat: number
  lon: number
}

export type MessageSegment = string | ContactShare | LocationShare

export function isContact(s: MessageSegment): s is ContactShare {
  return typeof s === 'object' && 'pubKey' in s
}
export function isLocation(s: MessageSegment): s is LocationShare {
  return typeof s === 'object' && 'lat' in s
}

const CONTACT_SRC  = '<([0-9a-fA-F]{64}):(\\d+):([^>\\n]+)>'
// Require ≥3 decimals on both numbers to avoid matching ordinary "1,2" text.
const LOCATION_SRC = '(-?\\d{1,2}\\.\\d{3,})\\s*,\\s*(-?\\d{1,3}\\.\\d{3,})'
const RICH_RE = new RegExp(`${CONTACT_SRC}|${LOCATION_SRC}`, 'g')

/**
 * Splits text into plain-string chunks and parsed rich tokens (contact shares,
 * location shares), preserving order. Returns `[text]` when nothing matches.
 */
export function parseMessageSegments(text: string): MessageSegment[] {
  const out: MessageSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  RICH_RE.lastIndex = 0
  while ((m = RICH_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      out.push({ raw: m[0], pubKey: m[1].toLowerCase(), type: parseInt(m[2], 10), name: m[3].trim() })
    } else {
      const lat = parseFloat(m[4]); const lon = parseFloat(m[5])
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        out.push({ raw: m[0], lat, lon })
      } else {
        out.push(m[0]) // out-of-range: keep as plain text
      }
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length ? out : [text]
}
