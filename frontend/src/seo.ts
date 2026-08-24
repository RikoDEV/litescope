import { getAppName } from './env'

export interface SeoPage {
  path: string
  title: string
  description: string
  priority: number
}

export const SITE_NAME = getAppName()
export const DEFAULT_TITLE = `${SITE_NAME} - MeshCore Network Analyzer`
export const DEFAULT_DESCRIPTION = 'Self-hosted MeshCore mesh network monitoring with live packet feeds, node analytics, RF signal charts, observer dashboards, maps, and packet decoding.'

const page = (path: string, title: string, description: string, priority: number): SeoPage => ({
  path,
  title: title ? `${title} - ${SITE_NAME}` : DEFAULT_TITLE,
  description,
  priority,
})

export const SEO_PAGES: readonly SeoPage[] = [
  page('/', '', DEFAULT_DESCRIPTION, 1),
  page('/packets', 'Live Packet Feed', 'Inspect MeshCore packet traffic in real time with decoded payload types, observer counts, RF telemetry, hashes, and packet trace links.', 0.9),
  page('/map', 'MeshCore Node Map', 'Explore MeshCore nodes and observers on an interactive map with positions, roles, and recent network activity.', 0.85),
  page('/live', 'Live Mesh Map', 'Watch live MeshCore network activity as packets, nodes, observers, and routes update on the map.', 0.85),
  page('/nodes', 'MeshCore Nodes', 'Browse MeshCore nodes by role, name, public key, location, packet counts, retransmits, and last-seen activity.', 0.85),
  page('/channels', 'MeshCore Channels', 'Analyze MeshCore channel traffic, encrypted channel hashes, message volume, activity over time, and top senders.', 0.8),
  page('/observers', 'MeshCore Observers', 'Monitor MeshCore observers, regions, hardware status, packet counts, uptime, battery telemetry, and observer analytics.', 0.8),
  page('/analytics', 'MeshCore Analytics', 'Review MeshCore network analytics including packet volume, RF signal quality, channels, observers, nodes, distance, scope, and hash behavior.', 0.9),
  page('/analytics/activity', 'Packet Activity Analytics', 'Analyze MeshCore packet activity over time with hourly buckets, traffic trends, and region-aware filtering.', 0.75),
  page('/analytics/rf', 'RF Signal Analytics', 'Inspect MeshCore RF quality with RSSI, SNR, payload-type signal summaries, and observer-level measurements.', 0.75),
  page('/analytics/nodes', 'Node Analytics', 'Find top MeshCore nodes by adverts and retransmits, with role, location, and last-seen context.', 0.75),
  page('/analytics/observers', 'Observer Analytics', 'Compare MeshCore observers by packet count, region, device status, uptime, and recent activity.', 0.75),
  page('/analytics/channels', 'Channel Analytics', 'Understand MeshCore channel usage with message counts, hourly activity, channel roster, and sender distribution.', 0.75),
  page('/analytics/hashes', 'Hash Analytics', 'Review MeshCore routing hash size distribution, hop identifiers, relayed packets, and firmware hash behavior.', 0.7),
  page('/analytics/scope', 'Scope Analytics', 'Analyze MeshCore packet scopes, scoped and unscoped traffic, RF quality by scope, and observer distribution.', 0.7),
  page('/analytics/distance', 'Distance and Hop Analytics', 'Study MeshCore route hops, link types, path lengths, geographic distances, and top observed routes.', 0.7),
  page('/decode', 'MeshCore Packet Decoder', 'Decode raw MeshCore packet hex locally to inspect transport fields, payload metadata, routes, and channel data.', 0.8),
]

export function seoForPath(pathname: string): SeoPage {
  const cleanPath = pathname.replace(/\/+$/, '') || '/'
  return SEO_PAGES.find(p => p.path === cleanPath) ?? {
    path: cleanPath,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    priority: 0.5,
  }
}
