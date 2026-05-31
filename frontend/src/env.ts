// Runtime env helper — reads window.__ENV__ (injected by docker-entrypoint.sh)
// and falls back to import.meta.env (populated by Vite in local dev).

declare global {
  interface Window { __ENV__?: Record<string, string> }
}

export function getEnv(key: string): string {
  return window.__ENV__?.[key] || (import.meta.env[key] as string | undefined) || ''
}
