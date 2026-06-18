export interface SeoPage {
  path: string
  title: string
  description: string
  priority: number
}

export const SITE_NAME = 'liteScope'
export const DEFAULT_TITLE = 'liteScope - MeshCore Network Analyzer'
export const DEFAULT_DESCRIPTION = 'Self-hosted MeshCore mesh network monitoring with live packet feeds, node analytics, RF signal charts, observer dashboards, maps, and packet decoding.'

export const SEO_PAGES = [
  {
    path: '/',
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    priority: 1,
  },
  {
    path: '/packets',
    title: 'Live Packet Feed - liteScope',
    description: 'Inspect MeshCore packet traffic in real time with decoded payload types, observer counts, RF telemetry, hashes, and packet trace links.',
    priority: 0.9,
  },
  {
    path: '/map',
    title: 'MeshCore Node Map - liteScope',
    description: 'Explore MeshCore nodes and observers on an interactive map with positions, roles, and recent network activity.',
    priority: 0.85,
  },
  {
    path: '/live',
    title: 'Live Mesh Map - liteScope',
    description: 'Watch live MeshCore network activity as packets, nodes, observers, and routes update on the map.',
    priority: 0.85,
  },
  {
    path: '/nodes',
    title: 'MeshCore Nodes - liteScope',
    description: 'Browse MeshCore nodes by role, name, public key, location, packet counts, retransmits, and last-seen activity.',
    priority: 0.85,
  },
  {
    path: '/channels',
    title: 'MeshCore Channels - liteScope',
    description: 'Analyze MeshCore channel traffic, encrypted channel hashes, message volume, activity over time, and top senders.',
    priority: 0.8,
  },
  {
    path: '/observers',
    title: 'MeshCore Observers - liteScope',
    description: 'Monitor MeshCore observers, regions, hardware status, packet counts, uptime, battery telemetry, and observer analytics.',
    priority: 0.8,
  },
  {
    path: '/analytics',
    title: 'MeshCore Analytics - liteScope',
    description: 'Review MeshCore network analytics including packet volume, RF signal quality, channels, observers, nodes, distance, scope, and hash behavior.',
    priority: 0.9,
  },
  {
    path: '/analytics/activity',
    title: 'Packet Activity Analytics - liteScope',
    description: 'Analyze MeshCore packet activity over time with hourly buckets, traffic trends, and region-aware filtering.',
    priority: 0.75,
  },
  {
    path: '/analytics/rf',
    title: 'RF Signal Analytics - liteScope',
    description: 'Inspect MeshCore RF quality with RSSI, SNR, payload-type signal summaries, and observer-level measurements.',
    priority: 0.75,
  },
  {
    path: '/analytics/nodes',
    title: 'Node Analytics - liteScope',
    description: 'Find top MeshCore nodes by adverts and retransmits, with role, location, and last-seen context.',
    priority: 0.75,
  },
  {
    path: '/analytics/observers',
    title: 'Observer Analytics - liteScope',
    description: 'Compare MeshCore observers by packet count, region, device status, uptime, and recent activity.',
    priority: 0.75,
  },
  {
    path: '/analytics/channels',
    title: 'Channel Analytics - liteScope',
    description: 'Understand MeshCore channel usage with message counts, hourly activity, channel roster, and sender distribution.',
    priority: 0.75,
  },
  {
    path: '/analytics/hashes',
    title: 'Hash Analytics - liteScope',
    description: 'Review MeshCore routing hash size distribution, hop identifiers, relayed packets, and firmware hash behavior.',
    priority: 0.7,
  },
  {
    path: '/analytics/scope',
    title: 'Scope Analytics - liteScope',
    description: 'Analyze MeshCore packet scopes, scoped and unscoped traffic, RF quality by scope, and observer distribution.',
    priority: 0.7,
  },
  {
    path: '/analytics/distance',
    title: 'Distance and Hop Analytics - liteScope',
    description: 'Study MeshCore route hops, link types, path lengths, geographic distances, and top observed routes.',
    priority: 0.7,
  },
  {
    path: '/decode',
    title: 'MeshCore Packet Decoder - liteScope',
    description: 'Decode raw MeshCore packet hex locally to inspect transport fields, payload metadata, routes, and channel data.',
    priority: 0.8,
  },
] as const satisfies readonly SeoPage[]

export function seoForPath(pathname: string): SeoPage {
  const cleanPath = pathname.replace(/\/+$/, '') || '/'
  return SEO_PAGES.find(page => page.path === cleanPath) ?? {
    path: cleanPath,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    priority: 0.5,
  }
}
