import { useEffect, type RefObject } from 'react'
import type { MiniMapOptions } from '../utils/miniMap'

/**
 * Mounts a static single-marker map into `ref` once the map code has loaded.
 * The Leaflet/maplibre chunk is fetched lazily on first use, so the hosting
 * page paints without waiting for it.
 */
export function useMiniMap(ref: RefObject<HTMLElement | null>, o: MiniMapOptions) {
  const { lat, lon, isDark, color, radius, zoom, invalidateOnMount } = o
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    void import('../utils/miniMap').then(({ createMiniMap }) => {
      if (cancelled || !ref.current) return
      cleanup = createMiniMap(ref.current, { lat, lon, isDark, color, radius, zoom, invalidateOnMount })
    })
    return () => { cancelled = true; cleanup?.() }
  }, [ref, lat, lon, isDark, color, radius, zoom, invalidateOnMount])
}
