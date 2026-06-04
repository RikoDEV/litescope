// Deterministic color derivation for hash/label chips.

/**
 * Maps an arbitrary string to a stable HSL color so the same hash/channel always
 * renders the same hue. Used for packet-hash and channel chips.
 */
export function hashColor(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff
  return `hsl(${h % 360}, 65%, 55%)`
}
