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
  hopSize?: number
  bestScope?: string
  bestPath?: string[]
  byteSize: number
  channelHash?: string
  decoded?: DecodedPayload
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
}

export interface Node {
  pubKey: string
  name: string
  role: string
  lat: number | null
  lon: number | null
  lastSeen: string
  firstSeen: string
  advertCount: number
  batteryMv?: number
  temperatureC?: number
}

export interface Observer {
  id: string
  name: string
  iata: string
  lastSeen: string
  firstSeen: string
  packetCount: number
  model?: string
  firmware?: string
  batteryMv?: number
  uptimeSecs?: number
  noiseFloor?: number
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
  avgSnr?: number
  avgRssi?: number
}

export interface RichPacket extends Packet {
  bestObserver: string
  bestIata?: string
  bestSnr?: number
  bestRssi?: number
}

export interface NodeOverview extends Node {
  packetsToday: number
  totalPackets: number
  avgHops: number
  avgSnr?: number
  heardBy: ObserverStat[]
  recentPackets: RichPacket[]
}

export interface WSMessage {
  type: 'packet'
  data: Packet
}

export const PAYLOAD_NAMES: Record<number, string> = {
  0: 'REQ', 1: 'RESPONSE', 2: 'TXT_MSG', 3: 'ACK', 4: 'ADVERT',
  5: 'GRP_TXT', 6: 'GRP_DATA', 7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE',
  10: 'MULTIPART', 11: 'CONTROL', 15: 'RAW_CUSTOM',
}

export const ROUTE_NAMES: Record<number, string> = {
  0: 'TRANSPORT_FLOOD', 1: 'FLOOD', 2: 'DIRECT', 3: 'TRANSPORT_DIRECT',
}
