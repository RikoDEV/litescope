import type { Channel, Node, Observer, OverviewStats, Packet, PacketDetail, RFStats } from '../types'
import { getEnv } from '../env'

const BASE = getEnv('VITE_API_URL')

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/** Shared analytics filter: time window (hours, 0/undefined = all time) + region. */
export interface AnalyticsParams {
  hours?: number
  regions?: string[]   // observer IATA codes (packet/observation filtering)
  countries?: string[] // ISO-A2 codes (geographic node filtering)
  lock?: boolean
}

/** Builds a query string from analytics params plus any extra fixed params. */
function aq(p?: AnalyticsParams, extra?: Record<string, string | number>): string {
  const sp = new URLSearchParams()
  if (extra) for (const [k, v] of Object.entries(extra)) sp.set(k, String(v))
  if (p?.hours) sp.set('hours', String(p.hours))
  if (p?.regions?.length) sp.set('regions', p.regions.join(','))
  if (p?.countries?.length) sp.set('countries', p.countries.join(','))
  if (p?.lock) sp.set('lock', '1')
  const q = sp.toString()
  return q ? `?${q}` : ''
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

  channelsFiltered: (p?: AnalyticsParams) =>
    get<Channel[]>(`/api/channels${aq(p)}`),

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

  overview: (p?: AnalyticsParams) =>
    get<OverviewStats>(`/api/analytics/overview${aq(p)}`),

  packetsByType: (p?: AnalyticsParams) =>
    get<Record<string, number>>(`/api/analytics/packets-by-type${aq(p)}`),

  analyticsRF: (p?: AnalyticsParams) =>
    get<{ rssi: number[]; snr: number[]; totalObservations: number; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number } }>(`/api/analytics/rf${aq(p)}`),

  analyticsActivity: (hours = 24, p?: AnalyticsParams) =>
    get<Array<{ hour: string; label: string; count: number }>>(`/api/analytics/activity${aq(p, { hours })}`),

  analyticsNodesTop: (limit = 20, sort: 'adverts' | 'retransmits' = 'adverts', p?: AnalyticsParams) =>
    get<import('../types').Node[]>(`/api/analytics/nodes-top${aq(p, { limit, sort })}`),

  analyticsObserversTop: (limit = 20, p?: AnalyticsParams) =>
    get<import('../types').Observer[]>(`/api/analytics/observers-top${aq(p, { limit })}`),

  analyticsSnrByType: (p?: AnalyticsParams) =>
    get<Record<string, { avg: number; count: number }>>(`/api/analytics/snr-by-type${aq(p)}`),

  analyticsDistance: (p?: AnalyticsParams) =>
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
    }>(`/api/analytics/distance${aq(p)}`),

  analyticsScope: (p?: AnalyticsParams) =>
    get<{
      distribution: Array<{ scope: string; pktCount: number; obsCount: number }>
      rfByScope: Array<{ scope: string; avgSnr: number; avgRssi: number; obsCount: number }>
      topObservers: Array<{ scope: string; observerId: string; observerName: string; observerIata: string; count: number }>
      activityScopes: string[]
      activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
    }>(`/api/analytics/scope${aq(p)}`),

  analyticsHashes: (p?: AnalyticsParams) =>
    get<{
      sizeDistribution: Record<string, number>
      byRole: Record<string, Record<string, number>>
      overTime: Array<{ label: string; size1: number; size2: number; size3: number; sizeN: number }>
      multiByteAdopters: Array<{ pubKey: string; name: string; count: number; maxSize: number }>
      inconsistentHashes: Array<{ pubKey: string; name: string; role: string; currentHash: string; currentSize: number; sizesSeen: number[] }>
    }>(`/api/analytics/hashes${aq(p)}`),

  analyticsChannels: (p?: AnalyticsParams) =>
    get<{
      activityChannels: string[]
      activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
      topSenders: Array<{ sender: string; messageCount: number; channels: number }>
    }>(`/api/analytics/channels${aq(p)}`),

  observerAnalytics: (id: string, days = 7) =>
    get<{ timeline: Array<{ hour: string; label: string; count: number }>; snr: number[]; snrSummary: { avg: number; min: number; max: number }; packetTypes: Record<string, number> }>(`/api/observers/${encodeURIComponent(id)}/analytics?days=${days}`),

  decodePacket: (hex: string, channelKeys?: Record<string, string>) =>
    fetch(`${BASE}/api/decode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex, channelKeys }) }).then(r => r.json()),
}
