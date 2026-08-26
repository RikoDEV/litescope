import L from 'leaflet'
import { setWorkerUrl } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import '@maplibre/maplibre-gl-leaflet'

// maplibre-gl locates its worker script at runtime via a *dynamic* `new URL(...)` (the
// filename depends on a dev/prod branch computed at call time), which defeats bundlers'
// static asset detection — so the worker file never gets emitted to the production build's
// assets dir, and the request for it 404s (silently, since nginx's SPA fallback serves
// index.html for any unknown path). The `?worker&url` import forces Vite to bundle the
// worker's own internal import (`./maplibre-gl-shared.mjs`, otherwise unresolved for the
// same reason) into a single self-contained chunk and give us its real, hashed URL — a
// plain `?url` import copies the raw file without resolving that internal import, which
// still leaves the worker unable to start. Without a working worker no vector tiles ever
// get parsed, so the map renders only its style's background paint — black in dark mode.
setWorkerUrl(maplibreWorkerUrl)

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
    const glMap = glLayer.getMaplibreMap()
    glMap.on('error', e => console.error('[maplibre]', e.error))
    if (onReady) glMap.once('load', onReady)
    return glLayer
  }
  const tileLayer = L.tileLayer(OSM_URL, { attribution: '© OpenStreetMap', subdomains: 'abc', maxZoom: 19 })
  if (onReady) tileLayer.on('load', onReady)
  if (onLoading) tileLayer.on('loading', onLoading)
  return tileLayer.addTo(map)
}
