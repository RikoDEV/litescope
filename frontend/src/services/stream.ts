import type { WSMessage } from '../types'
import { getEnv } from '../env'

type Handler = (msg: WSMessage) => void

const WS_URL = (() => {
  const base = getEnv('VITE_API_URL')
  if (base.startsWith('http')) return base.replace(/^http/, 'ws') + '/ws'
  const loc = window.location
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
})()

class StreamService {
  private ws: WebSocket | null = null
  private handlers: Set<Handler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private paused = false

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    try {
      this.ws = new WebSocket(WS_URL)
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
        this.reconnectTimer = setTimeout(() => this.connect(), 3000)
      }
      this.ws.onerror = () => {
        this.ws?.close()
      }
    } catch {
      this.reconnectTimer = setTimeout(() => this.connect(), 3000)
    }
  }

  subscribe(handler: Handler) {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  setPaused(v: boolean) { this.paused = v }
  isPaused() { return this.paused }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
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
