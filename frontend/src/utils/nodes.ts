import type { Node } from '../types'

/**
 * Whether a node counts as "active": infrastructure nodes (repeater/room) are
 * given a 72h staleness window, everything else 24h. Mirrors the backend
 * threshold in store.NodesFiltered.
 */
export function isNodeActive(n: Node): boolean {
  const ms = (n.role === 'repeater' || n.role === 'room') ? 72 * 3600e3 : 24 * 3600e3
  return Date.now() - new Date(n.lastSeen).getTime() < ms
}
