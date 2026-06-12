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
  hours?: number | undefined
  regions?: string[] | undefined   // observer IATA codes (packet/observation filtering)
  countries?: string[] | undefined // ISO-A2 codes (geographic node filtering)
  lock?: boolean | undefined
}

export interface PacketParams {
  search?: string | undefined
  payloadTypes?: number[] | undefined
  routeType?: number | null | undefined
  regions?: string[] | undefined
  lock?: boolean | undefined
  minObs?: number | undefined
  sinceMs?: number | undefined
  sort?: 'id' | 'payloadType' | 'routeType' | 'obsCount' | 'firstSeen' | undefined
  dir?: 'asc' | 'desc' | undefined
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

function packetQuery(limit: number, offset: number, p?: PacketParams): string {
  const sp = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const search = p?.search?.trim()
  if (search) sp.set('search', search)
  if (p?.payloadTypes?.length) sp.set('types', p.payloadTypes.join(','))
  if (p?.routeType !== null && p?.routeType !== undefined) sp.set('routeType', String(p.routeType))
  if (p?.regions?.length) sp.set('regions', p.regions.join(','))
  if (p?.lock) sp.set('lock', '1')
  if (p?.minObs && p.minObs > 1) sp.set('minObs', String(p.minObs))
  if (p?.sinceMs && p.sinceMs > 0) sp.set('sinceMs', String(Math.floor(p.sinceMs)))
  if (p?.sort) sp.set('sort', p.sort)
  if (p?.dir) sp.set('dir', p.dir)
  return sp.toString()
}

export const api = {
  packets: (limit = 50, offset = 0, params?: PacketParams) =>
    get<{ total: number; packets: Packet[] }>(`/api/packets?${packetQuery(limit, offset, params)}`),

  packet: (hash: string) =>
    get<PacketDetail>(`/api/packets/${encodeURIComponent(hash)}`),

  nodes: (opts?: { iata?: string | undefined; status?: string | undefined; lastHeard?: string | undefined }) => {
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

  channelMessages: (hash: string, limit = 100, offset = 0, p?: AnalyticsParams) =>
    get<Packet[]>(`/api/channels/${encodeURIComponent(hash)}/messages${aq(p, { limit, offset })}`),

  overview: (p?: AnalyticsParams) =>
    get<OverviewStats>(`/api/analytics/overview${aq(p)}`),

  packetsByType: (p?: AnalyticsParams) =>
    get<Record<string, number>>(`/api/analytics/packets-by-type${aq(p)}`),

  analyticsRF: (p?: AnalyticsParams) =>
    get<{ rssi: number[]; snr: number[]; totalObservations: number; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number } }>(`/api/analytics/rf${aq(p)}`),

  // Aggregates only — the raw rssi/snr arrays grow with history (hundreds of
  // KB); use this wherever the histograms aren't rendered.
  analyticsRFSummary: (p?: AnalyticsParams) =>
    get<{ totalObservations: number; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number } }>(`/api/analytics/rf${aq(p, { summary: 1 })}`),

  analyticsActivity: (hours = 24, p?: AnalyticsParams) =>
    get<{
      buckets: Array<{ hour: string; label: string; count: number; activeNodes: number; avgFanout: number; payloads: Record<string, number> }>
      payloadTypes: string[]
    }>(`/api/analytics/activity${aq(p, { hours })}`),

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
      hashMatrices: Record<string, {
        bytes: number
        trackedNodes: number
        routingNodes: number
        unknownModeNodes: number
        distinctPrefixes: number
        spaceTotal: number
        spacePct: number
        collisions: number
        cells: Array<{
          hex: string
          reserved: boolean
          state: 'empty' | 'taken' | 'collision'
          nodeCount: number
          routingCount: number
          maxGroup: number
          collisionCount: number
          groups: Array<{
            prefix: string
            routingCount: number
            nodes: Array<{ pubKey: string; name: string; role: string; currentHash?: string; currentSize?: number }>
          }>
        }>
      }>
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
