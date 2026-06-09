import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import L from 'leaflet'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Button from '@mui/material/Button'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import PauseIcon from '@mui/icons-material/Pause'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import FastForwardIcon from '@mui/icons-material/FastForward'
import CloseIcon from '@mui/icons-material/Close'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Node, Packet } from '../types'
import { PAYLOAD_NAMES, PAYLOAD_COLORS } from '../types'
import { hasValidLocation, validLatLon } from '../utils/geo'
import { escapeHtml } from '../utils/html'
import { ROLES, ROLE_GLYPH, roleColor, roleMarkerSvg } from '../utils/roles'
import { parseHops } from '../utils/packets'
import { formatDistanceToNow } from 'date-fns'

// ─── constants ───────────────────────────────────────────────────────────────

const SPEEDS      = [0.25, 0.5, 1, 2, 4, 8]
const HOP_MS      = 900    // ms per path segment
const BURST_MS    = 600    // burst/ring duration at each node on arrival
const TAIL_MS     = 900    // fade-out after last node
const SNAKE_MS    = HOP_MS // tail fully gone when dot reaches the next node
const SINGLE_LIFE = 7000   // lifetime for single-point (ring) traces
const MAX_RINGS   = 6      // max concentric rings drawn
const HOP_RADIUS  = 40     // px per hop ring
const MIN_RADIUS  = 40     // minimum outermost radius
const DOT_RADIUS  = 3.5    // px, traveling dot size

// ─── types ───────────────────────────────────────────────────────────────────

interface TracePoint { lat: number; lon: number }

interface ActiveTrace {
  id: string
  points: TracePoint[]   // [sender, ...hops, observer]
  hopCount: number       // rings to draw for single-point mode
  color: string
  payloadType: number
  birthTime: number
  lifetime: number       // total ms: HOP_MS*(segs) + TAIL_MS or SINGLE_LIFE
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Best-effort: match a hex hop identifier to a located node by pubKey prefix. */
function matchHop(hopHex: string, nodes: Node[]): Node | undefined {
  const h = hopHex.toUpperCase()
  if (h.length < 2) return undefined
  return nodes.find(n => hasValidLocation(n.lat, n.lon) && n.pubKey.toUpperCase().startsWith(h))
}

/** Append an 8-bit alpha suffix to a #rrggbb hex color string. */
function hexAlpha(hex: string, a: number): string {
  return hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')
}

/** Draw a glowing rounded arc on canvas. */
function drawRing(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  color: string, opacity: number, lineWidth: number,
) {
  if (r < 1 || opacity <= 0) return
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.shadowBlur = 10
  ctx.shadowColor = color
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/** Draw a glowing dot. */
function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  color: string, opacity: number,
) {
  if (opacity <= 0) return
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.shadowBlur = 14
  ctx.shadowColor = color
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}


// ─── component ───────────────────────────────────────────────────────────────

export default function LiveMap() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const location = useLocation()
  const [replayBanner, setReplayBanner] = useState<string | null>(null)

  // DOM refs
  const mapDiv      = useRef<HTMLDivElement>(null)
  const traceCanvas = useRef<HTMLCanvasElement>(null)
  const tlCanvas    = useRef<HTMLCanvasElement>(null)

  // Leaflet refs
  const mapRef      = useRef<L.Map | null>(null)
  const nodesLayer  = useRef<L.LayerGroup | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)

  // Animation refs
  const rafId      = useRef<number>(0)
  const traces     = useRef<ActiveTrace[]>([])
  const nodesRef   = useRef<Node[]>([])  // always-current copy for rAF closure

  // VCR refs
  const vcrBuffer      = useRef<Packet[]>([])
  const vcrMode        = useRef<'LIVE' | 'PAUSED' | 'REPLAY'>('LIVE')
  const pendingReplayPkt = useRef<Packet | null>(null)  // packet-trace replay
  const vcrPlayhead = useRef(-1)
  const vcrSpeed    = useRef(1)
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const rateWindow  = useRef<number[]>([])

  // React state
  const [nodes,     setNodes]     = useState<Node[]>([])
  const [liveFeed,  setLiveFeed]  = useState<Packet[]>([])
  const [mode,      setMode]      = useState<'LIVE' | 'PAUSED' | 'REPLAY'>('LIVE')
  const [missed,    setMissed]    = useState(0)
  const [speed,     setSpeed]     = useState(1)
  const [pktRate,   setPktRate]   = useState(0)
  const [totalTraces, setTotalTraces] = useState(0)
  const [showFeed,   setShowFeed]   = useState(true)
  const [showLegend, setShowLegend] = useState(() => localStorage.getItem('livemap-legend') !== 'false')

  // Keep nodesRef in sync
  useEffect(() => { nodesRef.current = nodes }, [nodes])

  // ── Map init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return
    // preferCanvas keeps the many ungrouped node markers on a single canvas so
    // zoom/pan stays smooth (DOM markers repaint every frame and lag badly).
    const map = L.map(mapDiv.current, { center: [20, 0], zoom: 2, zoomControl: false, preferCanvas: true })

    // Tile layer added by the theme-aware effect below

    nodesLayer.current = L.layerGroup().addTo(map)
    mapRef.current = map

    // Append canvas AFTER Leaflet builds its DOM so it's the last child and renders on top
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1000;'
    mapDiv.current.appendChild(canvas)
    traceCanvas.current = canvas

    return () => {
      cancelAnimationFrame(rafId.current)
      canvas.remove()
      traceCanvas.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  // ── Tile layer (theme-aware) ─────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current; if (!map) return
    if (tileLayerRef.current) { tileLayerRef.current.remove(); tileLayerRef.current = null }
    const isDark = theme.palette.mode === 'dark'
    tileLayerRef.current = L.tileLayer(
      isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: isDark ? '© OpenStreetMap © CARTO' : '© OpenStreetMap', subdomains: isDark ? 'abcd' : 'abc', maxZoom: 19 }
    ).addTo(map)
  }, [theme.palette.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Node markers ────────────────────────────────────────────────────────────
  useEffect(() => {
    const layer = nodesLayer.current; const map = mapRef.current; if (!layer) return
    layer.clearLayers()
    const latlngs: L.LatLngExpression[] = []
    nodes.forEach(n => {
      if (!hasValidLocation(n.lat, n.lon)) return
      const color = roleColor(n.role, md3)
      const active = Date.now() - new Date(n.lastSeen).getTime() < 24 * 3600e3
      const marker = L.circleMarker([n.lat!, n.lon!], {
        radius: 3.5, color: theme.palette.mode === 'dark' ? '#0f172a' : '#ffffff', weight: 1,
        fillColor: color, fillOpacity: active ? 0.9 : 0.3,
      }).bindTooltip(escapeHtml(n.name || n.pubKey.slice(0, 12)), { permanent: false, direction: 'top', offset: [0, -8] })
      layer.addLayer(marker)
      latlngs.push([n.lat!, n.lon!])
    })
    if (map && latlngs.length > 0 && map.getZoom() === 2) {
      map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 12 })
    }
  }, [nodes, theme.palette.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create trace from packet ─────────────────────────────────────────────
  const createTrace = useCallback((pkt: Packet) => {
    const dec = pkt.decoded

    const validLoc = validLatLon

    // Case-insensitive node lookup by full pubKey or prefix
    const findNode = (id: string) => {
      const up = id.toUpperCase()
      return nodesRef.current.find(n =>
        n.pubKey.toUpperCase() === up || n.pubKey.toUpperCase().startsWith(up)
      )
    }

    const obsNode = pkt.bestObserver ? findNode(pkt.bestObserver) : undefined
    const obsLoc  = validLoc(obsNode?.lat, obsNode?.lon)

    const addPoint = (la: number | null | undefined, lo: number | null | undefined, pts: TracePoint[]) => {
      const loc = validLoc(la, lo)
      if (loc && !pts.find(p => p.lat === loc[0] && p.lon === loc[1])) {
        pts.push({ lat: loc[0], lon: loc[1] })
      }
    }

    // Resolution chain for origin:
    // 1. GPS directly in decoded payload (adverts)
    // 2. Sender's last known location from nodesRef
    // 3. First resolvable intermediate hop (relay node)
    // 4. Observer location (at least show "packet arrived here")
    const senderPk = (dec?.pubKey ?? '') as string
    let origin: [number, number] | null =
      validLoc(dec?.lat as number | undefined, dec?.lon as number | undefined) ??
      (senderPk ? validLoc(findNode(senderPk)?.lat, findNode(senderPk)?.lon) : null)

    if (!origin) {
      for (const hop of (pkt.bestPath ?? [])) {
        const loc = validLoc(matchHop(hop, nodesRef.current)?.lat, matchHop(hop, nodesRef.current)?.lon)
        if (loc) { origin = loc; break }
      }
    }

    if (!origin) origin = obsLoc
    if (!origin) return

    const hopCount = Math.max(pkt.maxHops ?? 0, 1)
    const color    = PAYLOAD_COLORS[pkt.payloadType] ?? '#94a3b8'

    // Build full path: origin → intermediate hops → observer
    // addPoint deduplication handles the case where origin IS one of the hops
    const points: TracePoint[] = [{ lat: origin[0], lon: origin[1] }]
    ;(pkt.bestPath ?? []).forEach(hop => {
      const matched = matchHop(hop, nodesRef.current)
      addPoint(matched?.lat, matched?.lon, points)
    })
    addPoint(obsLoc?.[0], obsLoc?.[1], points)

    const numSegs = Math.max(1, points.length - 1)
    const lifetime = points.length > 1 ? numSegs * HOP_MS + TAIL_MS : SINGLE_LIFE
    traces.current = [
      { id: `${pkt.id}-${Date.now()}`, points, hopCount, color, payloadType: pkt.payloadType, birthTime: Date.now(), lifetime },
      ...traces.current,
    ].slice(0, 80)
    setTotalTraces(c => c + 1)
  }, [])

  // ── Process incoming packet ────────────────────────────────────────────────
  const processPacket = useCallback((pkt: Packet) => {
    rateWindow.current.push(Date.now())
    setLiveFeed(prev => [pkt, ...prev.slice(0, 29)])

    // Update node positions from advert packets
    const dec = pkt.decoded
    if (pkt.payloadType === 4 && dec?.pubKey) {
      const lat = dec.lat as number | undefined
      const lon = dec.lon as number | undefined
      const pubKey = dec.pubKey as string
      const name   = dec.name as string | undefined
      if (lat != null && lon != null) {
        setNodes(prev => {
          const idx = prev.findIndex(n => n.pubKey === pubKey)
          const flags = dec.flags as { type?: number } | undefined
          const role  = flags?.type === 2 ? 'repeater' : flags?.type === 3 ? 'room' : flags?.type === 4 ? 'sensor' : 'companion'
          const updated: Node = {
            pubKey, name: name ?? pubKey.slice(0, 8), role,
            lat, lon, lastSeen: pkt.firstSeen,
            firstSeen: idx >= 0 ? prev[idx].firstSeen : pkt.firstSeen,
            advertCount: idx >= 0 ? prev[idx].advertCount + 1 : 1,
          }
          if (idx >= 0) { const n = [...prev]; n[idx] = updated; return n }
          return [...prev, updated]
        })
      }
    }
    createTrace(pkt)
  }, [createTrace])

  // ── WebSocket ────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = stream.subscribe(msg => {
      if (msg.type !== 'packet') return
      vcrBuffer.current.push(msg.data)
      if (vcrBuffer.current.length > 2000) vcrBuffer.current.shift()
      drawTimeline()
      if (vcrMode.current === 'PAUSED') { setMissed(m => m + 1); return }
      if (vcrMode.current !== 'LIVE') return
      processPacket(msg.data)
    })
    return unsub
  }, [processPacket]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load initial data ────────────────────────────────────────────────────
  useEffect(() => {
    api.nodes().then(res => setNodes(res.nodes ?? []))
    api.packets(300, 0).then(res => {
      const sorted = [...(res.packets ?? [])].sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime())
      vcrBuffer.current = sorted
      drawTimeline()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Replay a single packet trace (used by trace page + VCR Replay button) ──
  const replayPacketTrace = useCallback((pkt: Packet) => {
    const validLoc = validLatLon

    // Collect all resolvable points: origin (payload/sender) + hops + observer
    const points: [number, number][] = []
    const involvedKeys = new Set<string>()
    const dec = pkt.decoded

    const fromPayload = validLoc(dec?.lat as number | undefined, dec?.lon as number | undefined)
    if (fromPayload) points.push(fromPayload)
    const senderPk = (dec?.pubKey ?? '') as string
    if (senderPk) {
      const senderNode = nodesRef.current.find(n => n.pubKey === senderPk)
      if (senderNode) {
        involvedKeys.add(senderNode.pubKey)
        const loc = validLoc(senderNode.lat, senderNode.lon)
        if (loc && !fromPayload) points.push(loc)
      }
    }
    for (const hop of (pkt.bestPath ?? [])) {
      const n = matchHop(hop, nodesRef.current)
      if (n) {
        involvedKeys.add(n.pubKey)
        const loc = validLoc(n.lat, n.lon)
        if (loc) points.push(loc)
      }
    }
    if (pkt.bestObserver) {
      const obs = nodesRef.current.find(n =>
        n.pubKey.toUpperCase() === pkt.bestObserver!.toUpperCase() ||
        n.pubKey.toUpperCase().startsWith(pkt.bestObserver!.toUpperCase())
      )
      if (obs) {
        involvedKeys.add(obs.pubKey)
        const loc = validLoc(obs.lat, obs.lon)
        if (loc) points.push(loc)
      }
    }

    // Trigger the animation
    processPacket(pkt)
    setReplayBanner((dec?.name as string | undefined) || pkt.hash.slice(0, 12))

    // Zoom to fit all involved points
    if (mapRef.current && points.length > 0) {
      if (points.length === 1) {
        mapRef.current.flyTo(points[0], Math.max(mapRef.current.getZoom(), 11), { duration: 1.2 })
      } else {
        mapRef.current.flyToBounds(L.latLngBounds(points), { padding: [80, 80], maxZoom: 13, duration: 1.2 })
      }
    }

    // Hide all node markers, then show only involved ones with accent styling
    if (nodesLayer.current && mapRef.current) {
      mapRef.current.removeLayer(nodesLayer.current)
    }
    let replayMarkers: L.LayerGroup | null = null
    if (mapRef.current) {
      replayMarkers = L.layerGroup().addTo(mapRef.current)
      for (const node of nodesRef.current) {
        if (!involvedKeys.has(node.pubKey)) continue
        if (!hasValidLocation(node.lat, node.lon)) continue
        const color = roleColor(node.role, md3)
        const icon = L.divIcon({
          html: roleMarkerSvg(node.role, color, 1, '#ffffff', 22),
          className: '', iconSize: [22, 22], iconAnchor: [11, 11],
        })
        L.marker([node.lat!, node.lon!], { icon })
          .bindTooltip(escapeHtml(node.name || node.pubKey.slice(0, 12)), { permanent: true, direction: 'top', offset: [0, -12] })
          .addTo(replayMarkers)
      }
    }

    // Estimate animation lifetime using the same formula as createTrace
    const numSegs  = Math.max(1, points.length - 1)
    const animLife = points.length > 1 ? numSegs * HOP_MS + TAIL_MS : SINGLE_LIFE
    const cleanup  = animLife + 500

    setTimeout(() => {
      setReplayBanner(null)
      replayMarkers && mapRef.current?.removeLayer(replayMarkers)
      if (nodesLayer.current && mapRef.current) {
        nodesLayer.current.addTo(mapRef.current)
      }
      pause()
    }, cleanup)
  }, [processPacket]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Replay a specific packet from router state ───────────────────────────
  useEffect(() => {
    const pkt = (location.state as { replayPacket?: Packet } | undefined)?.replayPacket
    if (!pkt) return
    pendingReplayPkt.current = pkt
    const id = setTimeout(() => replayPacketTrace(pkt), 600)
    return () => clearTimeout(id)
  }, [replayPacketTrace]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Rate counter ────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      rateWindow.current = rateWindow.current.filter(t => now - t < 60000)
      setPktRate(rateWindow.current.length)
    }, 2000)
    return () => clearInterval(id)
  }, [])

  // ── VCR ─────────────────────────────────────────────────────────────────
  const pause = useCallback(() => {
    vcrMode.current = 'PAUSED'; setMode('PAUSED'); setMissed(0)
  }, [])

  const skipToLive = useCallback(() => {
    if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null }
    vcrMode.current = 'LIVE'; vcrPlayhead.current = -1
    setMode('LIVE'); setMissed(0); drawTimeline()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startReplay = useCallback((from?: number) => {
    if (replayTimer.current) clearInterval(replayTimer.current)
    const buf = vcrBuffer.current; if (!buf.length) return
    vcrPlayhead.current = from ?? 0; vcrMode.current = 'REPLAY'; setMode('REPLAY'); setMissed(0)
    replayTimer.current = setInterval(() => {
      if (vcrPlayhead.current >= buf.length - 1) { skipToLive(); return }
      vcrPlayhead.current++
      processPacket(buf[vcrPlayhead.current])
      drawTimeline()
    }, 1000 / vcrSpeed.current)
  }, [processPacket, skipToLive]) // eslint-disable-line react-hooks/exhaustive-deps

  const changeSpeed = (s: number) => {
    vcrSpeed.current = s; setSpeed(s)
    if (vcrMode.current === 'REPLAY') startReplay(vcrPlayhead.current)
  }

  // ── Timeline canvas ────────────────────────────────────────────────────
  const drawTimeline = useCallback(() => {
    const canvas = tlCanvas.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = md3.surfaceContainerHighest; ctx.fillRect(0, 0, W, H)
    const buf = vcrBuffer.current; if (!buf.length) return
    const minTs = new Date(buf[0].firstSeen).getTime()
    const maxTs = new Date(buf[buf.length - 1].firstSeen).getTime()
    const range = maxTs - minTs || 1; const BUCKETS = 80
    const counts = new Array(BUCKETS).fill(0)
    for (const p of buf) {
      const i = Math.min(BUCKETS - 1, Math.floor((new Date(p.firstSeen).getTime() - minTs) / range * BUCKETS))
      counts[i]++
    }
    const maxC = Math.max(...counts, 1); const bw = W / BUCKETS
    ctx.fillStyle = alpha(md3.primary, 0.45)
    for (let i = 0; i < BUCKETS; i++) {
      const h = (counts[i] / maxC) * (H - 2)
      ctx.fillRect(i * bw, H - h, bw - 0.5, h)
    }
    const ph = vcrPlayhead.current < 0 ? W : (vcrPlayhead.current / Math.max(buf.length - 1, 1)) * W
    ctx.strokeStyle = md3.primary; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(ph, 0); ctx.lineTo(ph, H); ctx.stroke()
    if (vcrMode.current === 'LIVE') { ctx.fillStyle = '#22c55e'; ctx.fillRect(W - 4, 0, 4, H) }
  }, [md3.primary, md3.surfaceContainerHighest])

  const onTimelineClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = tlCanvas.current; if (!canvas) return
    const pct = (e.clientX - canvas.getBoundingClientRect().left) / canvas.width
    startReplay(Math.round(pct * Math.max(vcrBuffer.current.length - 1, 0)))
  }, [startReplay])

  // ── Animation loop ────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      rafId.current = requestAnimationFrame(tick)
      const canvas = traceCanvas.current
      const map    = mapRef.current
      if (!canvas || !map) return

      const dpr = window.devicePixelRatio || 1
      const w   = canvas.clientWidth   // logical CSS pixels
      const h   = canvas.clientHeight
      if (w === 0 || h === 0) return

      // Keep backing buffer in sync with display size every frame
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width  = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Re-apply DPR scale every frame — canvas.width assignment resets the transform.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const now   = Date.now()
      const alive: ActiveTrace[] = []

      for (const trace of traces.current) {
        const elapsed = now - trace.birthTime
        if (elapsed > trace.lifetime) continue
        alive.push(trace)

        // Convert geo points to canvas pixels
        const canvasPts = trace.points.map(p => {
          const pt = map.latLngToContainerPoint([p.lat, p.lon])
          return { x: pt.x, y: pt.y }
        })
        const { x: cx, y: cy } = canvasPts[0]

        if (trace.points.length > 1) {
          // ── Multi-point: growing trail + segment-by-segment dot ─────────────
          const numSegs    = canvasPts.length - 1
          const travelMs   = numSegs * HOP_MS
          const travelling = elapsed < travelMs
          const progress   = Math.min(elapsed / travelMs, 1)  // 0→1 over travel phase

          // Current segment index and intra-segment progress (eased)
          const segsF   = progress * numSegs
          const segIdx  = Math.min(Math.floor(segsF), numSegs - 1)
          const rawSegT = segsF - segIdx
          const ep      = rawSegT < 0.5 ? 2*rawSegT*rawSegT : -1+(4-2*rawSegT)*rawSegT
          const from    = canvasPts[segIdx]
          const to      = canvasPts[segIdx + 1]
          const dotX    = travelling ? from.x + (to.x - from.x) * ep : canvasPts[numSegs].x
          const dotY    = travelling ? from.y + (to.y - from.y) * ep : canvasPts[numSegs].y

          // Tail fade after travel completes
          const tailFade = travelling ? 1 : Math.max(0, 1 - (elapsed - travelMs) / TAIL_MS)

          // Helper: opacity for a point that was "current" at time t_ms ago
          const snakeAlpha = (ageMs: number) =>
            Math.max(0, 1 - ageMs / SNAKE_MS) * tailFade

          // ── Snake trail: each segment fades based on how long ago the dot left it ──
          // Tail end (older) fades to transparent, head end (newer) stays bright.
          const drawSeg = (p0: {x:number;y:number}, p1: {x:number;y:number}, a0: number, a1: number) => {
            if (a0 <= 0 && a1 <= 0) return
            const grad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y)
            grad.addColorStop(0, hexAlpha(trace.color, a0 * 0.75))
            grad.addColorStop(1, hexAlpha(trace.color, a1 * 0.75))
            ctx.save()
            ctx.strokeStyle = grad; ctx.shadowColor = trace.color; ctx.shadowBlur = 10
            ctx.lineWidth = 3
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y)
            ctx.stroke(); ctx.restore()
          }

          for (let i = 0; i < segIdx; i++) {
            const a0 = snakeAlpha(elapsed - i * HOP_MS)        // age at segment start
            const a1 = snakeAlpha(elapsed - (i + 1) * HOP_MS)  // age at segment end
            drawSeg(canvasPts[i], canvasPts[i + 1], a0, a1)
          }

          // Active segment: from `from` to current dot position
          if (travelling) {
            const a0 = snakeAlpha(elapsed - segIdx * HOP_MS)          // age at segment start
            const a1 = snakeAlpha(0)                                    // dot is always "now"
            drawSeg(from, { x: dotX, y: dotY }, a0, a1)
          }

          // Traveling dot
          if (travelling) {
            drawDot(ctx, dotX, dotY, DOT_RADIUS + 2, trace.color, 0.95)
            drawDot(ctx, dotX, dotY, DOT_RADIUS - 1, '#fff', 0.85)
          }

          // Burst at each node as the dot arrives: node i is reached at t = i * HOP_MS
          for (let i = 0; i < canvasPts.length; i++) {
            const arrivalAge = elapsed - i * HOP_MS
            if (arrivalAge < 0 || arrivalAge > BURST_MS) continue
            const bt = arrivalAge / BURST_MS
            const ba = (1 - bt * bt) * tailFade
            const pt = canvasPts[i]
            const isLast = i === canvasPts.length - 1
            drawRing(ctx, pt.x, pt.y, 4 + bt * (isLast ? 30 : 22), trace.color, ba * 0.9, isLast ? 2.5 : 1.5)
            drawDot(ctx, pt.x, pt.y, isLast ? 4 : 3, trace.color, ba)
          }

        } else {
          // ── Single-point: concentric expanding rings ─────────────────────
          const t       = elapsed / trace.lifetime
          const fadeOut = Math.max(0, 1 - t * t * 1.2)
          const rings   = Math.min(trace.hopCount, MAX_RINGS)
          const maxR    = Math.max(MIN_RADIUS, rings * HOP_RADIUS)

          for (let i = rings; i >= 0; i--) {
            const ringMaxR   = (i + 1) * (maxR / (rings + 1))
            const ringRadius = t * ringMaxR
            const ringAlpha  = fadeOut * (1 - i / (rings + 1) * 0.5)
            drawRing(ctx, cx, cy, ringRadius, trace.color, ringAlpha, i === rings ? 2.5 : 1.5)
            if (i === rings && ringRadius > 4) {
              const angle = -Math.PI / 2 + t * Math.PI * 0.4
              drawDot(ctx, cx + ringRadius * Math.cos(angle), cy + ringRadius * Math.sin(angle), DOT_RADIUS, trace.color, fadeOut)
            }
          }

          drawDot(ctx, cx, cy, 5, trace.color, Math.min(fadeOut * 1.5, 1))

          ctx.save()
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * t * 0.5)
          grad.addColorStop(0, `${trace.color}${Math.round(fadeOut * 40).toString(16).padStart(2, '0')}`)
          grad.addColorStop(1, `${trace.color}00`)
          ctx.fillStyle = grad
          ctx.beginPath(); ctx.arc(cx, cy, maxR * t * 0.5, 0, Math.PI * 2); ctx.fill()
          ctx.restore()
        }
      }

      traces.current = alive
    }
    tick()
    return () => cancelAnimationFrame(rafId.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────
  const panelBg = alpha(md3.surfaceContainer, 0.9)

  return (
    <Box sx={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: '#0f172a' }}>

      {/* Map — canvas overlay is appended imperatively in map init so it sits above Leaflet's DOM */}
      <Box ref={mapDiv} sx={{ flex: 1, position: 'relative' }} />

      {/* Replay banner */}
      {replayBanner && (
        <Box sx={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1000, px: 2, py: 0.75, borderRadius: 50,
          background: alpha('#0f172a', 0.85), border: `1px solid ${alpha('#22c55e', 0.5)}`,
          backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', gap: 0.75,
          pointerEvents: 'none',
        }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e',
            animation: 'pulse 1s infinite',
            '@keyframes pulse': { '0%': { opacity: 1 }, '50%': { opacity: 0.3 }, '100%': { opacity: 1 } },
          }} />
          <Typography sx={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
            Replaying · {replayBanner}
          </Typography>
        </Box>
      )}

      {/* ── VCR bar ─────────────────────────────────────────────────────────── */}
      <Paper elevation={3} sx={{
        borderRadius: 0, flexShrink: 0,
        borderTop: `1px solid ${md3.outlineVariant}`,
        background: md3.surfaceContainerHigh,
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
          <Chip label={mode} size="small" sx={{
            background: mode === 'LIVE' ? alpha('#22c55e', 0.2) : mode === 'PAUSED' ? alpha('#f59e0b', 0.2) : alpha(md3.primary, 0.2),
            color:      mode === 'LIVE' ? '#22c55e'             : mode === 'PAUSED' ? '#f59e0b'             : md3.primary,
            fontWeight: 700, fontSize: 11,
          }} />

          {mode === 'LIVE' && (
            <IconButton size="small" onClick={pause} sx={{ color: md3.onSurfaceVariant }}>
              <PauseIcon fontSize="small" />
            </IconButton>
          )}
          {mode === 'PAUSED' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Typography variant="caption" sx={{ color: '#f59e0b' }}>+{missed}</Typography>
              <Button size="small" variant="outlined" startIcon={<PlayArrowIcon />}
                onClick={() => {
                  if (pendingReplayPkt.current) replayPacketTrace(pendingReplayPkt.current)
                  else startReplay(Math.max(0, vcrBuffer.current.length - missed - 1))
                }}>
                Replay
              </Button>
              <Button size="small" variant="contained" startIcon={<FastForwardIcon />} onClick={skipToLive}>Live</Button>
            </Box>
          )}
          {mode === 'REPLAY' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Button size="small" variant="contained" startIcon={<FastForwardIcon />} onClick={skipToLive}>Live</Button>
              <Typography variant="caption" sx={{ color: md3.primary }}>
                {vcrPlayhead.current + 1} / {vcrBuffer.current.length}
              </Typography>
            </Box>
          )}

          <ToggleButtonGroup exclusive value={speed} onChange={(_, s) => s && changeSpeed(s)} size="small">
            {SPEEDS.map(s => (
              <ToggleButton key={s} value={s} sx={{ fontSize: 10, px: { xs: 0.75, sm: 1 }, py: 0.25 }}>{s}×</ToggleButton>
            ))}
          </ToggleButtonGroup>

          {/* Canvas: desktop — inline between speed and stats; mobile — wraps to its own full-width row */}
          <Box component="canvas" ref={tlCanvas} width={360} height={28} onClick={onTimelineClick}
            sx={{
              order: { xs: 999, sm: 0 },
              flexBasis: { xs: '100%', sm: 'auto' },
              flexShrink: { xs: 0, sm: 1 },
              minWidth: { xs: 'unset', sm: 60 },
              maxWidth: { xs: 'none', sm: 360 },
              mt: { xs: 0.25, sm: 0 },
              cursor: 'crosshair', borderRadius: 2, border: `1px solid ${md3.outlineVariant}`, display: 'block',
            }}
          />

          <Typography variant="caption" sx={{ ml: 'auto', color: md3.onSurfaceVariant, whiteSpace: 'nowrap', fontSize: { xs: 10, sm: 11 } }}>
            <Box component="span" sx={{ color: '#22c55e' }}>{nodes.filter(n => hasValidLocation(n.lat, n.lon)).length}</Box>
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}> nodes · </Box>
            <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}> · </Box>
            <Box component="span" sx={{ color: '#f59e0b' }}>{pktRate}</Box>/min{' · '}
            <Box component="span" sx={{ color: md3.primary }}>{totalTraces}</Box>
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}> traces</Box>
          </Typography>
        </Box>
      </Paper>

      {/* ── Legend (top-right, collapsible) ─────────────────────────────────── */}
      <Paper elevation={3} sx={{
        position: 'absolute', top: 8, right: 8, zIndex: 1000,
        borderRadius: 2, background: panelBg, backdropFilter: 'blur(8px)',
        overflow: 'hidden',
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer' }}
          onClick={() => setShowLegend(v => { const next = !v; localStorage.setItem('livemap-legend', String(next)); return next })}>
          <Typography variant="overline" sx={{ color: md3.onSurfaceVariant, fontSize: 9, lineHeight: 1 }}>Legend</Typography>
          <IconButton size="small" sx={{ color: md3.outline, p: 0, ml: 1 }}>
            {showLegend ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Box>
        {showLegend && (
          <Box sx={{ px: 1.5, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {[4, 5, 2, 9, 8].filter(pt => PAYLOAD_COLORS[pt]).map(pt => (
              <Box key={pt} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: PAYLOAD_COLORS[pt], boxShadow: `0 0 6px ${PAYLOAD_COLORS[pt]}` }} />
                <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10 }}>{PAYLOAD_NAMES[pt]}</Typography>
              </Box>
            ))}
            <Box sx={{ height: '1px', background: alpha(md3.outlineVariant, 0.4), my: 0.25 }} />
            {ROLES.map(role => (
              <Box key={role} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Box component="span" sx={{ width: 12, textAlign: 'center', color: roleColor(role, md3), fontSize: 11, lineHeight: 1 }}>{ROLE_GLYPH[role]}</Box>
                <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, textTransform: 'capitalize' }}>{role}</Typography>
              </Box>
            ))}
          </Box>
        )}
      </Paper>

      {/* ── Live feed (bottom-left) ──────────────────────────────────────────── */}
      {showFeed && (
        <Paper elevation={4} sx={{
          position: 'absolute', bottom: 64, left: 8, zIndex: 1000,
          p: 1.5, borderRadius: 3, width: 280, maxHeight: 260, overflow: 'auto',
          background: panelBg, backdropFilter: 'blur(8px)',
        }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
            <Typography variant="overline" sx={{ color: md3.onSurfaceVariant, lineHeight: 1, fontSize: 10 }}>
              {t('map.liveFeed')}
            </Typography>
            <IconButton size="small" onClick={() => setShowFeed(false)} sx={{ color: md3.outline, p: 0.25 }}>
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
          {liveFeed.length === 0 && (
            <Typography variant="caption" sx={{ color: md3.outline }}>{t('map.waiting')}</Typography>
          )}
          {liveFeed.map(pkt => {
            const dec   = pkt.decoded
            const color = PAYLOAD_COLORS[pkt.payloadType] ?? md3.outline
            const name  = (dec?.name ?? dec?.sender ?? dec?.channel) as string | undefined
            const hops  = pkt.maxHops ?? 0
            return (
              <Box key={pkt.id} sx={{ py: 0.4, borderBottom: `1px solid ${alpha(md3.outlineVariant, 0.3)}` }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Box sx={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: color, boxShadow: `0 0 5px ${color}` }} />
                  <Typography variant="caption" sx={{ color, fontWeight: 700, fontSize: 11 }}>
                    {PAYLOAD_NAMES[pkt.payloadType] ?? pkt.payloadType}
                  </Typography>
                  {hops > 0 && (
                    <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>{hops} hops</Typography>
                  )}
                  <Typography variant="caption" sx={{ color: md3.outline, ml: 'auto', fontSize: 10, flexShrink: 0 }}>
                    {formatDistanceToNow(new Date(pkt.firstSeen), { addSuffix: true })}
                  </Typography>
                </Box>
                {name && (
                  <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10, pl: 2 }}>{name}</Typography>
                )}
              </Box>
            )
          })}
        </Paper>
      )}
      {!showFeed && (
        <Button size="small" variant="outlined" onClick={() => setShowFeed(true)}
          sx={{ position: 'absolute', bottom: 64, left: 8, zIndex: 1000, background: panelBg }}>
          {t('map.liveFeed')}
        </Button>
      )}
    </Box>
  )
}
