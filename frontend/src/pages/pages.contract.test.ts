import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('..', import.meta.url))
const pagesDir = join(srcDir, 'pages')
const read = (path: string) => readFileSync(path, 'utf-8')
const appSource = () => read(join(srcDir, 'App.tsx'))
const pageSource = (page: string) => read(join(pagesDir, `${page}.tsx`))

const pageContracts: Record<string, {
  route: string
  snippets: string[]
}> = {
  Home: {
    route: '<Route index element={<Home />} />',
    snippets: ['api.overview()', 'api.analyticsActivity(24)', 'api.observers()', 'api.packets(6, 0)', 'api.analyticsRFSummary()'],
  },
  Packets: {
    route: 'path="packets" element={<Packets />}',
    snippets: ['useSearchParams()', 'api.packets(PAGE, offset, packetQuery)', 'api.packet(hash)', 'stream.subscribe', 'stream.setPaused(paused)'],
  },
  PacketTrace: {
    route: 'path="packets/:hash/trace" element={<PacketTrace />}',
    snippets: ['useParams<{ hash: string }>()', 'api.packet(hash)', "navigate('/live', { state: { replayPacket: pkt } })"],
  },
  MapView: {
    route: 'path="map" element={<MapView />}',
    snippets: ["import 'leaflet/dist/leaflet.css'", "import 'leaflet.markercluster/dist/MarkerCluster.css'", 'api.nodes()', 'api.packets(500, 0)', 'stream.subscribe'],
  },
  LiveMap: {
    route: 'path="live" element={<LiveMap />}',
    snippets: ["import 'leaflet/dist/leaflet.css'", "localStorage.getItem('livemap-legend')", 'api.nodes()', 'api.packets(300, 0)', 'stream.subscribe', 'marker.on(\'click\', () => navigate(`/nodes/${encodeURIComponent(n.pubKey)}`))'],
  },
  Nodes: {
    route: 'path="nodes" element={<Nodes />}',
    snippets: ['useSearchParams()', 'api.iatas()', 'api.nodes({ iata:', 'api.nodeOverview(n.pubKey)', 'NodeDetailPanel'],
  },
  NodePage: {
    route: 'path="nodes/:pubkey" element={<NodePage />}',
    snippets: ["import 'leaflet/dist/leaflet.css'", 'api.nodes()', 'pubkey.toLowerCase()', 'x.pubKey.toLowerCase() === routePubKey', 'api.nodeOverview(n.pubKey)', 'api.nodeRF(n.pubKey)', 'api.nodePackets(n.pubKey, 50)'],
  },
  Channels: {
    route: 'path="channels/:hash" element={<Channels />}',
    snippets: ['useParams<{ hash?: string }>()', 'api.channelsFiltered', 'api.channelMessages', 'stream.subscribe', 'LS_KEYS.channelSeen'],
  },
  Observers: {
    route: 'path="observers" element={<Observers />}',
    snippets: ['useSearchParams()', 'api.observers()', 'api.observerAnalytics(id, d)', "getEnv('VITE_MQTT_HOST')", 'o.id.toLowerCase().slice(0, 22)', 'navigate(`/nodes/${encodeURIComponent(selected.id.toLowerCase())}`)'],
  },
  Analytics: {
    route: 'path="analytics/:tab" element={<Analytics />}',
    snippets: ['useParams<{ tab?: string }>()', 'api.overview(params)', 'api.analyticsActivity(hours, params)', 'api.analyticsDistance(params)', 'api.analyticsScope(params)', 'navigate(`/nodes/${encodeURIComponent(n.pubKey)}`)', 'navigate(`/observers?id=${encodeURIComponent(o.id)}`)', 'navigate(`/observers?id=${encodeURIComponent(o.observerId)}`)', 'navigate(`/nodes/${encodeURIComponent(p.nodeAPubKey)}`)', 'navigate(`/nodes/${encodeURIComponent(p.nodeBPubKey)}`)'],
  },
  Decoder: {
    route: 'path="decode" element={<Decoder />}',
    snippets: ['loadChannelKeys()', 'api.decodePacket(h', 'navigator.clipboard.writeText'],
  },
  NotFound: {
    route: 'path="*" element={<NotFound />}',
    snippets: ["navigate('/', { replace: true })"],
  },
}

describe('page module contracts', () => {
  it('has a contract for every page module', () => {
    const pageFiles = readdirSync(pagesDir)
      .filter(name => name.endsWith('.tsx') && !name.includes('.test.'))
      .map(name => basename(name, '.tsx'))
      .sort()

    expect(Object.keys(pageContracts).sort()).toEqual(pageFiles)
  })

  it('lazy-loads every page from App.tsx', () => {
    const app = appSource()

    for (const page of Object.keys(pageContracts)) {
      expect(app).toContain(`const ${page}`)
      expect(app).toContain(`lazy(() => import('./pages/${page}'))`)
    }
  })

  it('registers each page route in App.tsx', () => {
    const app = appSource()

    for (const { route } of Object.values(pageContracts)) {
      expect(app).toContain(route)
    }
  })

  it('keeps each page wired to its critical data and behavior dependencies', () => {
    for (const [page, contract] of Object.entries(pageContracts)) {
      const source = pageSource(page)

      expect(source).toContain(`export default function ${page}`)
      expect(source).not.toContain('import.meta.env')
      for (const snippet of contract.snippets) expect(source).toContain(snippet)
    }
  })
})
