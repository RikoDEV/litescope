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

// Shared base-tile setup for every Leaflet map in the app. Both themes use OpenFreeMap's
// vector styles (via maplibre-gl-leaflet) — free of any API key, and unlike hotlinking
// OSM's own raster tile server directly, within OpenFreeMap's terms for this volume of
// embedded usage (direct tile.openstreetmap.org embedding got us rate-limited with 403s).
// See CLAUDE.md / commit history for why CARTO (which requires a key) was dropped earlier.
const LIGHT_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'

/**
 * Adds the theme-appropriate base layer to `map` and returns it. Callers own the
 * returned layer's lifecycle (remove it before swapping themes).
 *
 * `onReady` fires once the style has painted (maplibre's `load` event) — used by callers
 * that gate other canvas overlays on tile readiness. `onLoading` has no vector-tile
 * equivalent (maplibre streams tiles continuously after the initial `load`, with no
 * discrete "loading again" event) and is accepted only for caller compatibility.
 */
export function addBaseTileLayer(
  map: L.Map,
  isDark: boolean,
  onReady?: () => void,
  _onLoading?: () => void,
): L.Layer {
  const glLayer = L.maplibreGL({ style: isDark ? DARK_STYLE_URL : LIGHT_STYLE_URL })
  glLayer.addTo(map)
  const glMap = glLayer.getMaplibreMap()
  glMap.on('error', e => console.error('[maplibre]', e.error))
  if (onReady) glMap.once('load', onReady)
  return glLayer
}
