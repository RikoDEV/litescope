// Overwritten at container startup by docker-entrypoint.sh.
// Used for local dev fallback — getEnv() reads window.__ENV__ first,
// then falls back to import.meta.env (populated by Vite from .env).
window.__ENV__ = {};
