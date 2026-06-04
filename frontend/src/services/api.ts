import type { Channel, Node, Observer, OverviewStats, Packet, PacketDetail, RFStats } from '../types'
import { getEnv } from '../env'

const BASE = getEnv('VITE_API_URL')

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  packets: (limit = 50, offset = 0) =>
    get<{ total: number; packets: Packet[] }>(`/api/packets?limit=${limit}&offset=${offset}`),

  packet: (hash: string) =>
    get<PacketDetail>(`/api/packets/${hash}`),

  nodes: (opts?: { iata?: string; status?: string; lastHeard?: string }) => {
    const p = new URLSearchParams()
    if (opts?.iata)      p.set('iata',      opts.iata)
    if (opts?.status)    p.set('status',    opts.status)
    if (opts?.lastHeard) p.set('lastHeard', opts.lastHeard)
    const q = p.toString()
    return get<{ total: number; counts: Record<string, number>; nodes: Node[] }>(`/api/nodes${q ? '?' + q : ''}`)
  },

  iatas: () => get<string[]>('/api/iatas'),

  node: (pubKey: string) =>
    get<Node>(`/api/nodes/${encodeURIComponent(pubKey)}`),

  nodeOverview: (pubKey: string) =>
    get<import('../types').NodeOverview>(`/api/nodes/${encodeURIComponent(pubKey)}/overview`),

  nodePackets: (pubKey: string, limit = 50) =>
    get<Packet[]>(`/api/nodes/${encodeURIComponent(pubKey)}/packets?limit=${limit}`),

  nodeRF: (pubKey: string) =>
    get<RFStats>(`/api/nodes/${encodeURIComponent(pubKey)}/rf`),

  observers: () =>
    get<{ total: number; observers: Observer[] }>('/api/observers'),

  observer: (id: string) =>
    get<Observer>(`/api/observers/${encodeURIComponent(id)}`),

  channels: () =>
    get<Channel[]>('/api/channels'),

  channelMessages: (hash: string, limit = 100, offset = 0) =>
    get<Packet[]>(`/api/channels/${hash}/messages?limit=${limit}&offset=${offset}`),

  overview: () =>
    get<OverviewStats>('/api/analytics/overview'),

  packetsByType: () =>
    get<Record<string, number>>('/api/analytics/packets-by-type'),

  analyticsRF: () =>
    get<{ rssi: number[]; snr: number[]; totalObservations: number; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number } }>('/api/analytics/rf'),

  analyticsActivity: (hours = 24) =>
    get<Array<{ hour: string; label: string; count: number }>>(`/api/analytics/activity?hours=${hours}`),

  analyticsNodesTop: (limit = 20) =>
    get<import('../types').Node[]>(`/api/analytics/nodes-top?limit=${limit}`),

  analyticsObserversTop: (limit = 20) =>
    get<import('../types').Observer[]>(`/api/analytics/observers-top?limit=${limit}`),

  analyticsSnrByType: () =>
    get<Record<string, { avg: number; count: number }>>('/api/analytics/snr-by-type'),

  analyticsDistance: () =>
    get<{
      totalHops: number
      pathsAnalyzed: number
      avgHopDist: number
      maxHopDist: number
      byLinkType: { direct: number; singleRelay: number; multiRelay: number }
      hopDistribution: Array<{ hops: number; count: number }>
      activityByHour: Array<{ hour: string; label: string; avgHops: number; count: number }>
      top20Hops: Array<{ hash: string; firstSeen: string; hopCount: number; hops: string[]; observerName: string; observerIata: string; routeType: number; payloadType: number }>
      top10MultiHop: Array<{ hash: string; firstSeen: string; maxHops: number; bestPath: string[]; routeType: number; payloadType: number; obsCount: number }>
      geo: {
        nodesWithPos: number
        totalPairs: number
        maxDistKm: number
        avgDistKm: number
        distribution: Array<{ label: string; count: number }>
        topPairs: Array<{ nodeAName: string; nodeAPubKey: string; nodeBName: string; nodeBPubKey: string; distKm: number }>
      }
    }>('/api/analytics/distance'),

  analyticsScope: () =>
    get<{
      distribution: Array<{ scope: string; pktCount: number; obsCount: number }>
      rfByScope: Array<{ scope: string; avgSnr: number; avgRssi: number; obsCount: number }>
      topObservers: Array<{ scope: string; observerId: string; observerName: string; observerIata: string; count: number }>
      activityScopes: string[]
      activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
    }>('/api/analytics/scope'),

  analyticsHashes: () =>
    get<{
      sizeDistribution: Record<string, number>
      byRole: Record<string, Record<string, number>>
      overTime: Array<{ label: string; size1: number; size2: number; size3: number; sizeN: number }>
      multiByteAdopters: Array<{ pubKey: string; name: string; count: number; maxSize: number }>
    }>('/api/analytics/hashes'),

  observerAnalytics: (id: string, days = 7) =>
    get<{ timeline: Array<{ hour: string; label: string; count: number }>; snr: number[]; snrSummary: { avg: number; min: number; max: number }; packetTypes: Record<string, number> }>(`/api/observers/${encodeURIComponent(id)}/analytics?days=${days}`),

  decodePacket: (hex: string, channelKeys?: Record<string, string>) =>
    fetch(`${BASE}/api/decode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex, channelKeys }) }).then(r => r.json()),
}
