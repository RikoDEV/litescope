import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { addBaseTileLayer } from './mapTiles'

export interface MiniMapOptions {
  lat: number
  lon: number
  isDark: boolean
  color: string
  radius: number
  zoom?: number | undefined
  /** Call invalidateSize on the next frame (container sized by layout after mount). */
  invalidateOnMount?: boolean | undefined
}

/**
 * Static, non-interactive single-marker map used by the node/location cards.
 * Kept in its own module and only reached through `import()` (see useMiniMap)
 * so pages that show a small map — Nodes, Channels, NodePage — render
 * immediately instead of first downloading Leaflet + maplibre (~1.7 MB raw).
 * Returns a cleanup function.
 */
export function createMiniMap(el: HTMLElement, o: MiniMapOptions): () => void {
  const map = L.map(el, {
    center: [o.lat, o.lon], zoom: o.zoom ?? 13,
    zoomControl: false,
    dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  })
  addBaseTileLayer(map, o.isDark)
  // interactive: false — a clickable marker stops propagation on click, which
  // would swallow it before it reaches the card's own click handler.
  L.circleMarker([o.lat, o.lon], { radius: o.radius, color: '#fff', fillColor: o.color, fillOpacity: 1, weight: 2.5, interactive: false }).addTo(map)
  const frame = o.invalidateOnMount ? requestAnimationFrame(() => map.invalidateSize({ pan: false })) : 0
  return () => {
    if (frame) cancelAnimationFrame(frame)
    map.remove()
  }
}
