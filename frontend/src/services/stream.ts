import type { WSMessage } from '../types'
import { getEnv } from '../env'

type Handler = (msg: WSMessage) => void
type StatusHandler = (s: 'connected' | 'connecting' | 'disconnected') => void

const WS_URL = (() => {
  const base = getEnv('VITE_API_URL')
  if (base.startsWith('http')) return base.replace(/^http/, 'ws') + '/ws'
  const loc = window.location
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
})()

// How long the page must be hidden before we treat the socket as potentially dead
const BACKGROUND_STALE_MS = 5000

class StreamService {
  private ws: WebSocket | null = null
  private handlers: Set<Handler> = new Set()
  private statusHandlers: Set<StatusHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private paused = false
  private hiddenAt: number | null = null

  constructor() {
    if (typeof document === 'undefined') return
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hiddenAt = Date.now()
      } else {
        const hiddenMs = this.hiddenAt ? Date.now() - this.hiddenAt : 0
        this.hiddenAt = null
        if (hiddenMs > BACKGROUND_STALE_MS) this.forceReconnect()
      }
    })
  }

  private forceReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) { this.ws.onclose = null; this.ws.close() }
    this.ws = null
    this.connect()
  }

  private emitStatus() {
    const s = this.status
    this.statusHandlers.forEach(h => h(s))
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    try {
      this.ws = new WebSocket(WS_URL)
      this.emitStatus()
      this.ws.onopen = () => { this.emitStatus() }
      this.ws.onmessage = (e) => {
        if (this.paused) return
        try {
          const msg = JSON.parse(e.data) as WSMessage
          this.handlers.forEach((h) => h(msg))
        } catch {
          // ignore malformed
        }
      }
      this.ws.onclose = () => {
        this.emitStatus()
        this.reconnectTimer = setTimeout(() => this.connect(), 3000)
      }
      this.ws.onerror = () => {
        this.ws?.close()
      }
    } catch {
      this.emitStatus()
      this.reconnectTimer = setTimeout(() => this.connect(), 3000)
    }
  }

  subscribe(handler: Handler) {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler)
    return () => { this.statusHandlers.delete(handler) }
  }

  setPaused(v: boolean) { this.paused = v }
  isPaused() { return this.paused }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    // Detach onclose first: a deliberate disconnect must not schedule a reconnect.
    if (this.ws) { this.ws.onclose = null; this.ws.close() }
    this.ws = null
  }

  get status(): 'connected' | 'connecting' | 'disconnected' {
    if (!this.ws) return 'disconnected'
    switch (this.ws.readyState) {
      case WebSocket.OPEN: return 'connected'
      case WebSocket.CONNECTING: return 'connecting'
      default: return 'disconnected'
    }
  }
}

export const stream = new StreamService()
