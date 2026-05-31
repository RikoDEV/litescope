import type { Channel, Node, Observer, OverviewStats, Packet, PacketDetail, RFStats } from '../types'

const BASE = import.meta.env.VITE_API_URL ?? ''

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

  channelMessages: (hash: string, limit = 100) =>
    get<Packet[]>(`/api/channels/${hash}/messages?limit=${limit}`),

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

  observerAnalytics: (id: string, days = 7) =>
    get<{ timeline: Array<{ hour: string; label: string; count: number }>; snr: number[]; snrSummary: { avg: number; min: number; max: number }; packetTypes: Record<string, number> }>(`/api/observers/${encodeURIComponent(id)}/analytics?days=${days}`),

  decodePacket: (hex: string) =>
    fetch(`${BASE}/api/decode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex }) }).then(r => r.json()),
}
