import { useCallback, useEffect, useRef, useState } from 'react'
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
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Node, Packet } from '../types'
import { PAYLOAD_NAMES } from '../types'
import { formatDistanceToNow } from 'date-fns'

// ─── constants ───────────────────────────────────────────────────────────────

const SPEEDS      = [0.25, 0.5, 1, 2, 4, 8]
const HOP_MS      = 600    // ms per path segment
const BURST_MS    = 700    // burst/ring duration at each node on arrival
const TAIL_MS     = 1400   // fade-out after last node
const SINGLE_LIFE = 7000   // lifetime for single-point (ring) traces
const MAX_RINGS   = 6      // max concentric rings drawn
const HOP_RADIUS  = 40     // px per hop ring
const MIN_RADIUS  = 40     // minimum outermost radius
const DOT_RADIUS  = 3.5    // px, traveling dot size

const TYPE_COLORS: Record<number, string> = {
  4: '#22c55e', 5: '#3b82f6', 2: '#f59e0b', 3: '#94a3b8',
  9: '#ec4899', 8: '#14b8a6', 0: '#a855f7', 1: '#6366f1',
}
const roleColors: Record<string, string> = {
  repeater: '#818cf8', companion: '#34d399', room: '#22c55e', sensor: '#fbbf24',
}

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

function parseHops(pathJson: string): string[] {
  try { return JSON.parse(pathJson) ?? [] } catch { return [] }
}

/** Best-effort: match a hex hop identifier to a located node by pubKey prefix. */
function matchHop(hopHex: string, nodes: Node[]): Node | undefined {
  const h = hopHex.toUpperCase()
  if (h.length < 2) return undefined
  return nodes.find(n => n.lat != null && !(n.lat === 0 && n.lon === 0) && n.pubKey.toUpperCase().startsWith(h))
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

export default function TraceMap() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()

  // DOM refs
  const mapDiv      = useRef<HTMLDivElement>(null)
  const traceCanvas = useRef<HTMLCanvasElement>(null)
  const tlCanvas    = useRef<HTMLCanvasElement>(null)

  // Leaflet refs
  const mapRef    = useRef<L.Map | null>(null)
  const nodesLayer = useRef<L.LayerGroup | null>(null)

  // Animation refs
  const rafId      = useRef<number>(0)
  const traces     = useRef<ActiveTrace[]>([])
  const nodesRef   = useRef<Node[]>([])  // always-current copy for rAF closure

  // VCR refs
  const vcrBuffer   = useRef<Packet[]>([])
  const vcrMode     = useRef<'LIVE' | 'PAUSED' | 'REPLAY'>('LIVE')
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
  const [showFeed,  setShowFeed]  = useState(true)

  // Keep nodesRef in sync
  useEffect(() => { nodesRef.current = nodes }, [nodes])

  // ── Map init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return
    const map = L.map(mapDiv.current, { center: [20, 0], zoom: 2, zoomControl: true })

    // Dark tile layer for trace contrast
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      subdomains: 'abcd', maxZoom: 19,
    }).addTo(map)

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

  // ── Node markers ────────────────────────────────────────────────────────────
  useEffect(() => {
    const layer = nodesLayer.current; if (!layer) return
    layer.clearLayers()
    nodes.forEach(n => {
      if (n.lat == null || n.lon == null || (n.lat === 0 && n.lon === 0)) return
      const color = roleColors[n.role] ?? '#64748b'
      const active = Date.now() - new Date(n.lastSeen).getTime() < 24 * 3600e3
      const marker = L.circleMarker([n.lat, n.lon], {
        radius: 5, color: '#0f172a', weight: 1.5,
        fillColor: color, fillOpacity: active ? 0.9 : 0.3,
      }).bindTooltip(n.name || n.pubKey.slice(0, 12), { permanent: false, direction: 'top', offset: [0, -8] })
      layer.addLayer(marker)
    })
  }, [nodes])

  // ── Create trace from packet ─────────────────────────────────────────────
  const createTrace = useCallback((pkt: Packet) => {
    const dec = pkt.decoded

    const validLoc = (la: number | null | undefined, lo: number | null | undefined): [number, number] | null => {
      if (la == null || lo == null || (la === 0 && lo === 0)) return null
      return [la, lo]
    }

    // Resolve sender position from decoded payload first, then stored node
    let origin: [number, number] | null =
      validLoc(dec?.lat as number | undefined, dec?.lon as number | undefined) ??
      (dec?.pubKey
        ? validLoc(
            nodesRef.current.find(n => n.pubKey === (dec.pubKey as string))?.lat,
            nodesRef.current.find(n => n.pubKey === (dec.pubKey as string))?.lon,
          )
        : null)

    if (!origin) return

    const hopCount = Math.max(pkt.maxHops ?? 0, 1)
    const color    = TYPE_COLORS[pkt.payloadType] ?? '#94a3b8'

    // Build multi-point path: sender → intermediate hops → observer (receiver)
    const points: TracePoint[] = [{ lat: origin[0], lon: origin[1] }]

    const addPoint = (la: number | null | undefined, lo: number | null | undefined) => {
      const loc = validLoc(la, lo)
      if (loc && !points.find(p => p.lat === loc[0] && p.lon === loc[1])) {
        points.push({ lat: loc[0], lon: loc[1] })
      }
    }

    ;(pkt.bestPath ?? []).forEach(hop => {
      const matched = matchHop(hop, nodesRef.current)
      if (matched) addPoint(matched.lat, matched.lon)
    })

    // Append observer location as the final destination
    if (pkt.bestObserver) {
      const obs = nodesRef.current.find(n =>
        n.pubKey === pkt.bestObserver ||
        n.pubKey.toUpperCase().startsWith((pkt.bestObserver as string).toUpperCase())
      )
      addPoint(obs?.lat, obs?.lon)
    }

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
          // ── Multi-point: segment-by-segment travel ──────────────────────────
          const numSegs    = canvasPts.length - 1
          const segsDone   = Math.min(Math.floor(elapsed / HOP_MS), numSegs)
          const tailElapsed = elapsed - numSegs * HOP_MS   // negative until last node hit

          // Draw already-completed segments (fading)
          for (let i = 0; i < segsDone; i++) {
            const segAge   = elapsed - (i + 1) * HOP_MS    // how long ago this seg finished
            const segFade  = Math.max(0, 1 - segAge / (TAIL_MS * 0.8))
            ctx.save()
            ctx.globalAlpha = segFade * 0.55
            ctx.strokeStyle = trace.color; ctx.shadowColor = trace.color; ctx.shadowBlur = 6
            ctx.lineWidth = 2; ctx.setLineDash([6, 4])
            ctx.beginPath()
            ctx.moveTo(canvasPts[i].x, canvasPts[i].y)
            ctx.lineTo(canvasPts[i + 1].x, canvasPts[i + 1].y)
            ctx.stroke()
            ctx.setLineDash([]); ctx.restore()
          }

          // Draw active segment (dot traveling)
          if (segsDone < numSegs) {
            const segT  = (elapsed % HOP_MS) / HOP_MS
            const ep    = segT < 0.5 ? 2 * segT * segT : -1 + (4 - 2 * segT) * segT
            const from  = canvasPts[segsDone]
            const to    = canvasPts[segsDone + 1]
            const dotX  = from.x + (to.x - from.x) * ep
            const dotY  = from.y + (to.y - from.y) * ep

            // Partial line behind dot
            ctx.save()
            ctx.globalAlpha = 0.4
            ctx.strokeStyle = trace.color; ctx.shadowColor = trace.color; ctx.shadowBlur = 6
            ctx.lineWidth = 2; ctx.setLineDash([6, 4])
            ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(dotX, dotY)
            ctx.stroke(); ctx.setLineDash([]); ctx.restore()

            // Traveling dot (bright white core)
            drawDot(ctx, dotX, dotY, DOT_RADIUS + 2, trace.color, 0.9)
            drawDot(ctx, dotX, dotY, DOT_RADIUS - 1, '#fff', 0.8)
          }

          // Burst ring at each node when the dot arrives
          for (let i = 0; i <= segsDone && i < canvasPts.length; i++) {
            const arrivalAge = elapsed - i * HOP_MS
            if (arrivalAge < 0) continue
            const bt = arrivalAge / BURST_MS
            if (bt > 1) continue
            const ba = 1 - bt * bt
            const pt = canvasPts[i]
            drawRing(ctx, pt.x, pt.y, 4 + bt * 24, trace.color, ba * 0.85, i === canvasPts.length - 1 ? 2 : 1.5)
            drawDot(ctx, pt.x, pt.y, 3.5, trace.color, ba)
          }

          // Tail fade at the last node after all segments done
          if (tailElapsed > 0) {
            const tailFade = Math.max(0, 1 - tailElapsed / TAIL_MS)
            drawDot(ctx, canvasPts[numSegs].x, canvasPts[numSegs].y, 4, trace.color, tailFade * 0.5)
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

      {/* ── VCR bar ─────────────────────────────────────────────────────────── */}
      <Paper elevation={3} sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75,
        borderRadius: 0, flexShrink: 0,
        borderTop: `1px solid ${md3.outlineVariant}`,
        background: md3.surfaceContainerHigh,
      }}>
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
            <Typography variant="caption" sx={{ color: '#f59e0b' }}>+{missed} missed</Typography>
            <Button size="small" variant="outlined" startIcon={<PlayArrowIcon />}
              onClick={() => startReplay(Math.max(0, vcrBuffer.current.length - missed - 1))}>
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

        <ToggleButtonGroup exclusive value={speed} onChange={(_, s) => s && changeSpeed(s)} size="small" sx={{ ml: 1 }}>
          {SPEEDS.map(s => (
            <ToggleButton key={s} value={s} sx={{ fontSize: 10, px: 1, py: 0.25 }}>{s}×</ToggleButton>
          ))}
        </ToggleButtonGroup>

        <canvas ref={tlCanvas} width={360} height={28} onClick={onTimelineClick}
          style={{ cursor: 'crosshair', borderRadius: 8, border: `1px solid ${md3.outlineVariant}`, flexShrink: 1, minWidth: 60, maxWidth: 360 }} />

        <Typography variant="caption" sx={{ ml: 'auto', color: md3.onSurfaceVariant, whiteSpace: 'nowrap' }}>
          <Box component="span" sx={{ color: '#22c55e' }}>{nodes.filter(n => n.lat != null).length}</Box> nodes ·{' '}
          <Box component="span" sx={{ color: '#f59e0b' }}>{pktRate}</Box>/min ·{' '}
          <Box component="span" sx={{ color: md3.primary }}>{totalTraces}</Box> traces
        </Typography>
      </Paper>

      {/* ── Stats overlay (top-right) ────────────────────────────────────────── */}
      <Paper elevation={3} sx={{
        position: 'absolute', top: 8, right: 8, zIndex: 1000,
        px: 1.5, py: 1, borderRadius: 2,
        background: panelBg, backdropFilter: 'blur(8px)',
        display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 140,
      }}>
        {/* Legend */}
        {[4, 5, 2, 9, 8].filter(pt => TYPE_COLORS[pt]).map(pt => (
          <Box key={pt} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_COLORS[pt], boxShadow: `0 0 6px ${TYPE_COLORS[pt]}` }} />
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10 }}>
              {PAYLOAD_NAMES[pt]}
            </Typography>
          </Box>
        ))}
        <Box sx={{ height: '1px', background: alpha(md3.outlineVariant, 0.4), my: 0.25 }} />
        {/* Node role legend */}
        {Object.entries(roleColors).map(([role, color]) => (
          <Box key={role} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
            <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, textTransform: 'capitalize' }}>{role}</Typography>
          </Box>
        ))}
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
            const color = TYPE_COLORS[pkt.payloadType] ?? md3.outline
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
