// Route-chunk prefetching. Each entry is the same `import()` App.tsx hands to
// React.lazy, so the bundler resolves both to one chunk: calling it early just
// warms the module cache and the later lazy() render resolves instantly.
const ROUTE_CHUNKS: Record<string, () => Promise<unknown>> = {
  '/':          () => import('../pages/Home'),
  '/packets':   () => import('../pages/Packets'),
  '/map':       () => import('../pages/MapView'),
  '/live':      () => import('../pages/LiveMap'),
  '/nodes':     () => import('../pages/Nodes'),
  '/channels':  () => import('../pages/Channels'),
  '/observers': () => import('../pages/Observers'),
  '/analytics': () => import('../pages/Analytics'),
  '/decode':    () => import('../pages/Decoder'),
}

const started = new Set<string>()

/** Starts loading a route's chunk (once). Safe to call repeatedly, e.g. on hover. */
export function prefetchRoute(path: string): void {
  const load = ROUTE_CHUNKS[path]
  if (!load || started.has(path)) return
  started.add(path)
  load().catch(() => started.delete(path)) // retry on a later intent if it failed
}

type NetInfo = { saveData?: boolean; effectiveType?: string }

/**
 * After the first page is idle, warm the heaviest routes (the maps, whose
 * chunk is the largest in the app) unless the visitor asked to save data or is
 * on a slow link — then they only load on hover/focus or navigation.
 */
export function prefetchHeavyRoutesWhenIdle(): void {
  const conn = (navigator as Navigator & { connection?: NetInfo }).connection
  if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return
  const run = () => { prefetchRoute('/map'); prefetchRoute('/live') }
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(run, { timeout: 10_000 })
  else setTimeout(run, 4000)
}
