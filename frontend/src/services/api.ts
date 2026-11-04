import type { Channel, CoverageParams, CoverageResult, DirectLink, MapHeatPoint, Node, Observer, OverviewStats, Packet, PacketDetail, RFStats, ScopeRegion } from '../types'
import { getEnv } from '../env'

const BASE = getEnv('VITE_API_URL')

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = signal ? await fetch(`${BASE}${path}`, { signal }) : await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

type NodesResponse = { total: number; counts: Record<string, number>; nodes: Node[] }

type RFSummary = { avg: number; min: number; max: number }
export interface RFHistogramStats {
  totalObservations: number
  snrSummary: RFSummary
  rssiSummary: RFSummary
  snrHistogram?: Array<{ label: string; count: number }> | undefined
  rssiHistogram?: Array<{ label: string; count: number }> | undefined
  scatter?: Array<{ snr: number; rssi: number }> | undefined
}

// The unfiltered node list is wanted by many views at once (map, live map,
// channels, node page, spotlight search, packet detail — which remounts on
// every selection). Share one response for NODES_TTL_MS (the backend refreshes
// node metadata every 30 s) and dedupe concurrent requests, instead of
// downloading the full list again on each mount. Callers must treat it as
// read-only.
const NODES_TTL_MS = 30_000
let nodesCache: { at: number; promise: Promise<NodesResponse> } | null = null

function cachedNodes(): Promise<NodesResponse> {
  const now = Date.now()
  if (nodesCache && now - nodesCache.at < NODES_TTL_MS) return nodesCache.promise
  const promise = get<NodesResponse>('/api/nodes')
  nodesCache = { at: now, promise }
  promise.catch(() => { if (nodesCache?.promise === promise) nodesCache = null }) // don't cache failures
  return promise
}

/** Optional, config-gated backend features (GET /api/features). */
export interface Features {
  /** Wardrive coverage map layer (config wardrive.enabled). */
  coverage: boolean
}

// Feature flags only change on a server restart: fetch once per page load.
// A failed request (e.g. an older backend without the endpoint) resolves to
// everything disabled and isn't cached, so the next caller retries.
let featuresCache: Promise<Features> | null = null

function cachedFeatures(): Promise<Features> {
  if (featuresCache) return featuresCache
  const promise = get<Partial<Features>>('/api/features')
    .then(f => ({ coverage: f.coverage === true }))
  featuresCache = promise
  return promise.catch(() => {
    if (featuresCache === promise) featuresCache = null
    return { coverage: false }
  })
}

/** Shared analytics filter: time window (hours, 0/undefined = all time) + region. */
export interface AnalyticsParams {
  hours?: number | undefined
  regions?: string[] | undefined   // observer IATA codes (packet/observation filtering)
  countries?: string[] | undefined // ISO-A2 codes (geographic node filtering)
  lock?: boolean | undefined
  /** Aborts the request (e.g. when filters change before it completes). */
  signal?: AbortSignal | undefined
}

/** Rejection handler for aborted requests: ignore aborts, surface real errors. */
export function ignoreAbort(err: unknown): void {
  if ((err as { name?: string } | null)?.name === 'AbortError') return
  console.error(err)
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

  features: () => cachedFeatures(),

  packet: (hash: string) =>
    get<PacketDetail>(`/api/packets/${encodeURIComponent(hash)}`),

  nodes: (opts?: { status?: string | undefined; lastHeard?: string | undefined }) => {
    const p = new URLSearchParams()
    if (opts?.status)    p.set('status',    opts.status)
    if (opts?.lastHeard) p.set('lastHeard', opts.lastHeard)
    const q = p.toString()
    if (!q) return cachedNodes()
    return get<NodesResponse>(`/api/nodes?${q}`)
  },

  iatas: () => get<string[]>('/api/iatas'),

  channelsFiltered: (p?: AnalyticsParams) =>
    get<Channel[]>(`/api/channels${aq(p)}`, p?.signal),

  node: (pubKey: string) =>
    get<Node>(`/api/nodes/${encodeURIComponent(pubKey)}`),

  nodeOverview: (pubKey: string) =>
    get<import('../types').NodeOverview>(`/api/nodes/${encodeURIComponent(pubKey)}/overview`),

  nodePackets: (pubKey: string, limit = 50) =>
    get<Packet[]>(`/api/nodes/${encodeURIComponent(pubKey)}/packets?limit=${limit}`),

  nodeRF: (pubKey: string) =>
    get<RFStats>(`/api/nodes/${encodeURIComponent(pubKey)}/rf`),

  nodeClockHealth: (pubKey: string) =>
    get<import('../types').ClockHealthEntry>(`/api/nodes/${encodeURIComponent(pubKey)}/clock-health`),

  observers: () =>
    get<{ total: number; observers: Observer[] }>('/api/observers'),

  observer: (id: string) =>
    get<Observer>(`/api/observers/${encodeURIComponent(id)}`),

  channels: () =>
    get<Channel[]>('/api/channels'),

  channelMessages: (hash: string, limit = 100, offset = 0, p?: AnalyticsParams) =>
    get<Packet[]>(`/api/channels/${encodeURIComponent(hash)}/messages${aq(p, { limit, offset })}`, p?.signal),

  overview: (p?: AnalyticsParams) =>
    get<OverviewStats>(`/api/analytics/overview${aq(p)}`, p?.signal),

  packetsByType: (p?: AnalyticsParams) =>
    get<Record<string, number>>(`/api/analytics/packets-by-type${aq(p)}`, p?.signal),

  // Aggregates + server-side SNR/RSSI histograms and a paired, sampled scatter
  // (histogram=1) — not the raw per-observation arrays, which grow to
  // megabytes of JSON with history.
  analyticsRF: (p?: AnalyticsParams) =>
    get<RFHistogramStats>(`/api/analytics/rf${aq(p, { histogram: 1 })}`, p?.signal),

  // Aggregates only — the raw rssi/snr arrays grow with history (hundreds of
  // KB); use this wherever the histograms aren't rendered.
  analyticsRFSummary: (p?: AnalyticsParams) =>
    get<{ totalObservations: number; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number } }>(`/api/analytics/rf${aq(p, { summary: 1 })}`, p?.signal),

  analyticsActivity: (hours = 24, p?: AnalyticsParams) =>
    get<{
      buckets: Array<{ hour: string; label: string; count: number; activeNodes: number; avgFanout: number; payloads: Record<string, number> }>
      payloadTypes: string[]
    }>(`/api/analytics/activity${aq(p, { hours })}`, p?.signal),

  analyticsNodesTop: (limit = 20, sort: 'adverts' | 'retransmits' = 'adverts', p?: AnalyticsParams) =>
    get<import('../types').Node[]>(`/api/analytics/nodes-top${aq(p, { limit, sort })}`, p?.signal),

  analyticsObserversTop: (limit = 20, p?: AnalyticsParams) =>
    get<import('../types').Observer[]>(`/api/analytics/observers-top${aq(p, { limit })}`, p?.signal),

  analyticsSnrByType: (p?: AnalyticsParams) =>
    get<Record<string, { avg: number; count: number }>>(`/api/analytics/snr-by-type${aq(p)}`, p?.signal),

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
    }>(`/api/analytics/distance${aq(p)}`, p?.signal),

  analyticsScope: (p?: AnalyticsParams) =>
    get<{
      distribution: Array<{ scope: string; pktCount: number; obsCount: number }>
      rfByScope: Array<{ scope: string; avgSnr: number; avgRssi: number; obsCount: number }>
      topObservers: Array<{ scope: string; observerId: string; observerName: string; observerIata: string; count: number }>
      activityScopes: string[]
      activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
    }>(`/api/analytics/scope${aq(p)}`, p?.signal),

  analyticsScopeRegions: (p?: AnalyticsParams) =>
    get<ScopeRegion[]>(`/api/analytics/scope-regions${aq(p)}`, p?.signal),

  analyticsMapHeat: (p?: AnalyticsParams) =>
    get<MapHeatPoint[]>(`/api/analytics/map-heat${aq(p)}`, p?.signal),

  analyticsCoverage: (p?: CoverageParams) => {
    const extra: Record<string, string> = {}
    if (p?.precision) extra.precision = p.precision
    if (p?.repeater) extra.repeater = p.repeater
    if (p?.unverified) extra.unverified = '1'
    return get<CoverageResult>(`/api/analytics/coverage${aq(p, extra)}`, p?.signal)
  },

  analyticsDirectLinks: (p?: AnalyticsParams) =>
    get<DirectLink[]>(`/api/analytics/direct-links${aq(p)}`, p?.signal),

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
    }>(`/api/analytics/hashes${aq(p)}`, p?.signal),

  analyticsChannels: (p?: AnalyticsParams) =>
    get<{
      activityChannels: string[]
      activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
      topSenders: Array<{ sender: string; messageCount: number; channels: number }>
    }>(`/api/analytics/channels${aq(p)}`, p?.signal),

  analyticsClockHealth: (p?: AnalyticsParams) =>
    get<Array<{
      pubKey: string; name: string; role: string
      skewSeconds: number
      severity: 'ok' | 'warning' | 'critical' | 'absurd'
      driftPerDay: number
      lastAdvert: string
      samples: number
    }>>(`/api/analytics/clock-health${aq(p)}`, p?.signal),

  observerAnalytics: (id: string, days = 7) =>
    get<{ timeline: Array<{ hour: string; label: string; count: number }>; snr: number[]; snrSummary: { avg: number; min: number; max: number }; packetTypes: Record<string, number> }>(`/api/observers/${encodeURIComponent(id)}/analytics?days=${days}`),

  decodePacket: (hex: string, channelKeys?: Record<string, string>) =>
    fetch(`${BASE}/api/decode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex, channelKeys }) }).then(r => r.json()),
}
