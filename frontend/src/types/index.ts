export interface DecodedPayload {
  type: string
  pubKey?: string
  name?: string
  lat?: number
  lon?: number
  channel?: string
  channelHash?: number
  channelHashHex?: string
  decryptionStatus?: string
  text?: string
  sender?: string
  senderTimestamp?: number
  [key: string]: unknown
}

export interface Packet {
  id: number
  hash: string
  firstSeen: string
  routeType: number
  payloadType: number
  obsCount: number
  maxHops: number
  hopSize?: number | undefined
  bestScope?: string | undefined
  bestPath?: string[] | undefined
  bestObserver?: string | undefined
  regions?: string[] | undefined
  country?: string | undefined
  nodeLat?: number | undefined
  nodeLon?: number | undefined
  byteSize: number
  channelHash?: string | undefined
  decoded?: DecodedPayload | undefined
}

export interface PacketDetail extends Packet {
  rawHex: string
  observations: Observation[]
}

export interface Observation {
  id: number
  observerId: string
  observerName: string
  observerIata: string
  rssi: number | null
  snr: number | null
  direction: string
  pathJson: string
  timestamp: string
  rawHex?: string | undefined
}

export interface Node {
  pubKey: string
  name: string
  role: string
  lat: number | null
  lon: number | null
  locationApprox?: boolean | undefined
  lastSeen: string
  firstSeen: string
  advertCount: number
  regions?: string[] | undefined
  country?: string | undefined
  retransmitCount?: number | undefined
  batteryMv?: number | undefined
  temperatureC?: number | undefined
}

export interface Observer {
  id: string
  name: string
  iata: string
  lastSeen: string
  firstSeen: string
  packetCount: number
  model?: string | undefined
  firmware?: string | undefined
  batteryMv?: number | undefined
  uptimeSecs?: number | undefined
  noiseFloor?: number | undefined
}

export interface ScopeRegion {
  region: string
  lat: number
  lon: number
  observerCount: number
  pktCount: number
  obsCount: number
  dominantScope: string
  scopes: Array<{ scope: string; pktCount: number; obsCount: number }>
}

export interface MapHeatPoint {
  pubKey: string
  name: string
  role: string
  lat: number
  lon: number
  packetCount: number
  observationCount: number
  weight: number
}

export interface DirectLink {
  nodeA: DirectLinkNode
  nodeB: DirectLinkNode
  count: number
  directCount?: number
  routeCount?: number
  aToBCount: number
  bToACount: number
  avgSnr: number
  avgRssi: number
  signalCount?: number
  lastSeen: string
}

export interface DirectLinkNode {
  pubKey: string
  name: string
  role: string
  lat: number
  lon: number
}

export interface Channel {
  hash: string
  name: string
  messageCount: number
}

export interface OverviewStats {
  totalPackets: number
  totalNodes: number
  totalObservers: number
  packetRate: number
}

export interface RFStats {
  rssi: number[]
  snr: number[]
}

export interface ObserverStat {
  observerId: string
  observerName: string
  observerIata: string
  count: number
  avgSnr?: number | undefined
  avgRssi?: number | undefined
}

export interface RichPacket extends Packet {
  bestObserver: string
  bestIata?: string | undefined
  bestSnr?: number | undefined
  bestRssi?: number | undefined
}

export interface NodeOverview extends Node {
  packetsToday: number
  totalPackets: number
  avgHops: number
  avgSnr?: number | undefined
  heardBy: ObserverStat[]
  recentPackets: RichPacket[]
}

/** A live count update for an already-seen packet as more observers report it. */
export interface PacketUpdate {
  id: number
  hash: string
  obsCount: number
  maxHops: number
  hopSize?: number | undefined
  bestScope?: string | undefined
  bestPath?: string[] | undefined
  bestObserver?: string | undefined
  regions?: string[] | undefined
}

export type WSMessage =
  | { type: 'packet'; data: Packet }
  | { type: 'packetUpdate'; data: PacketUpdate }

export const PAYLOAD_NAMES: Record<number, string> = {
  0: 'REQ', 1: 'RESPONSE', 2: 'TXT_MSG', 3: 'ACK', 4: 'ADVERT',
  5: 'GRP_TXT', 6: 'GRP_DATA', 7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE',
  10: 'MULTIPART', 11: 'CONTROL', 15: 'RAW_CUSTOM',
}

export const PAYLOAD_COLORS: Record<number, string> = {
  0: '#a855f7', // REQ
  1: '#06b6d4', // RESPONSE
  2: '#f59e0b', // TXT_MSG
  3: '#6b7280', // ACK
  4: '#22c55e', // ADVERT
  5: '#3b82f6', // GRP_TXT
  6: '#8b5cf6', // GRP_DATA
  7: '#64748b', // ANON_REQ
  8: '#14b8a6', // PATH
  9: '#ec4899', // TRACE
  10: '#94a3b8', // MULTIPART
  11: '#475569', // CONTROL
  15: '#f97316', // RAW_CUSTOM
}

export const PAYLOAD_ICONS: Record<number, string> = {
  0: '❓', 1: '📨', 2: '✉️', 3: '✓', 4: '📡',
  5: '💬', 6: '📦', 7: '🔒', 8: '🛤️', 9: '🔍',
}

export const ROUTE_NAMES: Record<number, string> = {
  0: 'TRANSPORT_FLOOD', 1: 'FLOOD', 2: 'DIRECT', 3: 'TRANSPORT_DIRECT',
}
