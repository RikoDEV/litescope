// Shared packet/observation helpers. Previously defined inside
// components/PacketDetailPanel and duplicated in LiveMap.

/** Parses a path_json string into a hops array, tolerating malformed input. */
export function parseHops(pathJson: string): string[] {
  try {
    return JSON.parse(pathJson) ?? []
  } catch {
    return []
  }
}

/**
 * Collapses multiple observations of the same packet to one per observer,
 * keeping the strongest report (highest SNR, then RSSI, then most recent).
 */
export function deduplicateObs<T extends { observerId: string; snr: number | null; rssi: number | null; timestamp: string }>(obs: T[]): T[] {
  const map = new Map<string, T>()
  for (const o of obs) {
    const prev = map.get(o.observerId)
    if (!prev) { map.set(o.observerId, o); continue }
    const snrA = o.snr ?? -Infinity, snrB = prev.snr ?? -Infinity
    const rssiA = o.rssi ?? -Infinity, rssiB = prev.rssi ?? -Infinity
    if (snrA > snrB || (snrA === snrB && rssiA > rssiB) || (snrA === snrB && rssiA === rssiB && o.timestamp > prev.timestamp))
      map.set(o.observerId, o)
  }
  return [...map.values()]
}

/** Compact "Ns/Nm/Nh ago" relative timestamp for packet lists. */
export function relativeTime(ts: string): string {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  return `${Math.round(diff / 3600)}h ago`
}
