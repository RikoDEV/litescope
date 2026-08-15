import { getEnv } from '../env'

// Default center/zoom a Leaflet map opens at, configurable via VITE_MAP_LAT / VITE_MAP_LON / VITE_MAP_ZOOM.
// Falls back to a world view (lat 20, lon 0, zoom 2) — the pre-existing behavior — when unset, and
// in that unset case callers should also auto-fit the view to the loaded nodes' bounds on first load.
// Setting any of the three opts out of that auto-fit: the configured view is treated as intentional
// and left alone.
function envFloat(key: string, fallback: number): number {
  const raw = getEnv(key)
  const n = raw ? parseFloat(raw) : NaN
  return Number.isFinite(n) ? n : fallback
}

export const MAP_POSITION_CONFIGURED = getEnv('VITE_MAP_LAT') !== '' || getEnv('VITE_MAP_LON') !== '' || getEnv('VITE_MAP_ZOOM') !== ''
export const DEFAULT_MAP_LAT  = envFloat('VITE_MAP_LAT', 20)
export const DEFAULT_MAP_LON  = envFloat('VITE_MAP_LON', 0)
export const DEFAULT_MAP_ZOOM = envFloat('VITE_MAP_ZOOM', 2)
