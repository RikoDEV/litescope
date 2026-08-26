import L from 'leaflet'
import '@maplibre/maplibre-gl-leaflet'

// Shared base-tile setup for every Leaflet map in the app. Dark mode uses OpenFreeMap's
// vector "dark" style (via maplibre-gl-leaflet); light mode uses OSM raster tiles — both
// free of any API key. See CLAUDE.md / commit history for why CARTO (which requires a key)
// was dropped.
const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'

/**
 * Adds the theme-appropriate base layer to `map` and returns it. Callers own the
 * returned layer's lifecycle (remove it before swapping themes).
 *
 * `onReady` fires once tiles have painted (maplibre's `load`, or the raster layer's
 * `load` event) — used by callers that gate other canvas overlays on tile readiness.
 * `onLoading` fires when the raster layer starts a new load pass; it has no vector
 * equivalent since maplibre streams tiles continuously after the initial `load`.
 */
export function addBaseTileLayer(
  map: L.Map,
  isDark: boolean,
  onReady?: () => void,
  onLoading?: () => void,
): L.Layer {
  if (isDark) {
    const glLayer = L.maplibreGL({ style: DARK_STYLE_URL })
    glLayer.addTo(map)
    if (onReady) glLayer.getMaplibreMap().once('load', onReady)
    return glLayer
  }
  const tileLayer = L.tileLayer(OSM_URL, { attribution: '© OpenStreetMap', subdomains: 'abc', maxZoom: 19 })
  if (onReady) tileLayer.on('load', onReady)
  if (onLoading) tileLayer.on('loading', onLoading)
  return tileLayer.addTo(map)
}
