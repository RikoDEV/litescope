// Runtime env helper — reads window.__ENV__ (injected by docker-entrypoint.sh)
// and falls back to import.meta.env (populated by Vite in local dev).

declare global {
  interface Window { __ENV__?: Record<string, string> }
}

export function getEnv(key: string): string {
  return window.__ENV__?.[key] || (import.meta.env[key] as string | undefined) || ''
}

export function waitForEnv(
  ready: () => boolean,
  timeoutMs = 1000,
  intervalMs = 25,
): Promise<void> {
  if (ready()) return Promise.resolve()

  const start = performance.now()
  return new Promise(resolve => {
    const tick = () => {
      if (ready() || performance.now() - start >= timeoutMs) {
        resolve()
        return
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}
