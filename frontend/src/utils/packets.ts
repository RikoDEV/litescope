// Shared packet/observation helpers. Previously defined inside
// components/PacketDetailPanel and duplicated in LiveMap.
import type { Packet, PacketUpdate } from '../types'

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

/**
 * Applies a batch of live `packetUpdate`s (obs/hop counts climbing as a packet
 * propagates) to a packet list. Returns the same array when nothing matched,
 * so React can bail out of the re-render. One id → index map per batch instead
 * of a findIndex + full array copy per update.
 */
export function applyPacketUpdates<T extends Packet>(list: T[], updates: PacketUpdate[]): T[] {
  if (updates.length === 0 || list.length === 0) return list
  const index = new Map<number, number>()
  list.forEach((p, i) => index.set(p.id, i))
  let out: T[] | null = null
  for (const u of updates) {
    const i = index.get(u.id)
    if (i === undefined) continue
    out ??= [...list]
    const existing = out[i]!
    out[i] = {
      ...existing, obsCount: u.obsCount, maxHops: u.maxHops,
      hopSize: u.hopSize ?? existing.hopSize,
      bestScope: u.bestScope ?? existing.bestScope,
      bestPath: u.bestPath ?? existing.bestPath,
      bestObserver: u.bestObserver ?? existing.bestObserver,
      regions: u.regions ?? existing.regions,
    }
  }
  return out ?? list
}
