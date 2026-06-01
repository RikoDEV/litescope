import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Checkbox from '@mui/material/Checkbox'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Divider from '@mui/material/Divider'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import PauseIcon from '@mui/icons-material/Pause'
import FastForwardIcon from '@mui/icons-material/FastForward'
import CloseIcon from '@mui/icons-material/Close'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MapIcon from '@mui/icons-material/Map'
import { useTranslation } from 'react-i18next'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Node, NodeOverview, Packet, RFStats } from '../types'
import { PAYLOAD_NAMES } from '../types'
import NodeDetailPanel from '../components/NodeDetailPanel'
import { formatDistanceToNow } from 'date-fns'
import { useDateLocale } from '../hooks/useDateLocale'

// Fix leaflet icon
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

type VcrMode = 'LIVE' | 'PAUSED' | 'REPLAY'
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8]
const ACTIVE_MS = 24 * 3600e3

const LH_MS: Record<string, number> = {
  '1h': 3600e3, '6h': 6*3600e3, '24h': 24*3600e3, '7d': 7*24*3600e3, '30d': 30*24*3600e3,
}

const roleShapes: Record<string, (color: string, op: number, stroke: string) => string> = {
  repeater:  (c, o, s) => `<svg width="20" height="20" style="opacity:${o}"><polygon points="10,1 19,10 10,19 1,10" fill="${c}" stroke="${s}" stroke-width="1.5"/></svg>`,
  companion: (c, o, s) => `<svg width="20" height="20" style="opacity:${o}"><circle cx="10" cy="10" r="8" fill="${c}" stroke="${s}" stroke-width="1.5"/></svg>`,
  room:      (c, o, s) => `<svg width="20" height="20" style="opacity:${o}"><polygon points="10,1 17.6,5.5 17.6,14.5 10,19 2.4,14.5 2.4,5.5" fill="${c}" stroke="${s}" stroke-width="1.5"/></svg>`,
  sensor:    (c, o, s) => `<svg width="20" height="20" style="opacity:${o}"><polygon points="10,1 19,18 1,18" fill="${c}" stroke="${s}" stroke-width="1.5"/></svg>`,
}

const ROLE_SHAPES: Record<string, string> = { repeater: '◆', companion: '●', room: '■', sensor: '▲' }

const TYPE_COLORS: Record<number, string> = { 4: '#22c55e', 5: '#3b82f6', 2: '#f59e0b', 3: '#6b7280', 9: '#ec4899', 8: '#14b8a6' }
const TYPE_ICONS:  Record<number, string> = { 4: '📡', 5: '💬', 2: '✉️', 3: '✓', 9: '🔍', 8: '🛤️' }

export default function MapView() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const dateLocale = useDateLocale()

  const LH_OPTIONS = [
    { value: '',    label: t('common.anyTime') },
    { value: '1h',  label: '1h' },
    { value: '6h',  label: '6h' },
    { value: '24h', label: '24h' },
    { value: '7d',  label: '7d' },
    { value: '30d', label: '30d' },
  ]

  const ROLE_INFO: { role: 'repeater'|'companion'|'room'|'sensor'; label: string; shape: string }[] = [
    { role: 'repeater',  label: t('map.repeaters'),   shape: ROLE_SHAPES.repeater },
    { role: 'companion', label: t('map.companions'),  shape: ROLE_SHAPES.companion },
    { role: 'room',      label: t('map.roomServers'), shape: ROLE_SHAPES.room },
    { role: 'sensor',    label: t('map.sensors'),     shape: ROLE_SHAPES.sensor },
  ]

  const mapDiv         = useRef<HTMLDivElement>(null)
  const mapInstance    = useRef<L.Map | null>(null)
  const animLayer      = useRef<L.LayerGroup | null>(null)
  const clusterGroup   = useRef<L.MarkerClusterGroup | null>(null)
  const markersRef     = useRef<Map<string, L.Marker>>(new Map())
  const nodeLocRef     = useRef<Map<string, [number, number]>>(new Map())
  const animRAFs       = useRef<number[]>([])
  const timelineCanvas = useRef<HTMLCanvasElement>(null)

  const vcrMode      = useRef<VcrMode>('LIVE')
  const vcrBuffer    = useRef<Packet[]>([])
  const vcrPlayhead  = useRef(-1)
  const vcrMissed    = useRef(0)
  const vcrSpeed     = useRef(1)
  const replayTimer  = useRef<ReturnType<typeof setInterval> | null>(null)
  const rateWindow   = useRef<number[]>([])

  const [mode,      setMode]      = useState<VcrMode>('LIVE')
  const [missed,    setMissed]    = useState(0)
  const [speed,     setSpeed]     = useState(1)
  const [nodes,     setNodes]     = useState<Node[]>([])
  const [selected,  setSelected]  = useState<Node | null>(null)
  const [overview,  setOverview]  = useState<NodeOverview | null>(null)
  const [rf,        setRF]        = useState<RFStats | null>(null)
  const [liveFeed,  setLiveFeed]  = useState<Packet[]>([])
  const [pktRate,   setPktRate]   = useState(0)
  const [showFeed,  setShowFeed]  = useState(() => window.innerWidth >= 900)
  const [ctrlOpen,  setCtrlOpen]  = useState(true)

  const selectedRef = useRef<Node | null>(null)
  selectedRef.current = selected

  const selectNode = useCallback(async (n: Node) => {
    if (selectedRef.current?.pubKey === n.pubKey) { setSelected(null); setOverview(null); setRF(null); return }
    setSelected(n); setOverview(null); setRF(null)
    const [ov, rfData] = await Promise.all([api.nodeOverview(n.pubKey), api.nodeRF(n.pubKey)])
    setOverview(ov); setRF(rfData)
  }, [])

  // Filters
  const [roleVis, setRoleVis] = useState({ repeater: true, companion: true, room: true, sensor: true })
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'stale'>('all')
  const [lastHeardFilter, setLastHeardFilter] = useState('30d')
  const [byteSizeFilter, setByteSizeFilter] = useState<'all' | '1' | '2' | '3'>('all')
  const [showLabels, setShowLabels] = useState(false)
  const [quickJump, setQuickJump] = useState('')

  // pubKey → byte size of its most recent advert packet (built from VCR buffer)
  const nodeByteSizeRef = useRef<Map<string, number>>(new Map())

  const roleColor = (r: string) => ({ repeater: md3.primary, companion: md3.tertiary, room: '#22c55e', sensor: '#f59e0b' }[r] ?? md3.outline)

  // Count active/stale per role
  const typeCounts = useMemo(() => {
    const now = Date.now()
    return Object.fromEntries(ROLE_INFO.map(({ role }) => {
      const rn = nodes.filter(n => n.role === role)
      const active = rn.filter(n => now - new Date(n.lastSeen).getTime() < ACTIVE_MS).length
      return [role, { active, stale: rn.length - active }]
    }))
  }, [nodes])

  function makeIcon(role: string, active: boolean, label?: string) {
    const color  = roleColor(role)
    const stroke = theme.palette.mode === 'dark' ? '#111827' : '#ffffff'
    const fn     = roleShapes[role] ?? roleShapes.companion
    const svg    = fn(color, active ? 1 : 0.35, stroke)
    const html  = label
      ? `<div style="position:relative;display:inline-block">${svg}<span style="position:absolute;left:22px;top:3px;font-size:9px;color:${color};white-space:nowrap;font-family:monospace;background:rgba(0,0,0,0.55);padding:0 3px;border-radius:2px">${label}</span></div>`
      : svg
    return L.divIcon({ html, className: '', iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -13] })
  }

  // Rate counter
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      rateWindow.current = rateWindow.current.filter(t => now - t < 60000)
      setPktRate(rateWindow.current.length)
    }, 2000)
    return () => clearInterval(id)
  }, [])

  const tileLayerRef = useRef<L.TileLayer | null>(null)

  // Map init
  useEffect(() => {
    const el = mapDiv.current
    if (!el || mapInstance.current) return
    // Guard against React StrictMode double-invoke leaving a stale leaflet container
    if ((el as unknown as Record<string, unknown>)._leaflet_id) return
    const map = L.map(el, { center: [20, 0], zoom: 2, zoomControl: false, maxZoom: 19 })
    animLayer.current = L.layerGroup().addTo(map)
    const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 12, maxClusterRadius: 60 })
    cluster.addTo(map)
    clusterGroup.current = cluster
    mapInstance.current = map
    return () => { animRAFs.current.forEach(cancelAnimationFrame); map.remove(); mapInstance.current = null; clusterGroup.current = null }
  }, [])

  // Swap tile layer when theme changes
  useEffect(() => {
    const map = mapInstance.current; if (!map) return
    if (tileLayerRef.current) { tileLayerRef.current.remove(); tileLayerRef.current = null }
    const isDark = theme.palette.mode === 'dark'
    tileLayerRef.current = L.tileLayer(
      isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution: isDark ? '© OpenStreetMap © CARTO' : '© OpenStreetMap',
        subdomains: isDark ? 'abcd' : 'abc',
        maxZoom: 19,
      }
    ).addTo(map)
  }, [theme.palette.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load nodes + seed VCR buffer
  useEffect(() => {
    api.nodes().then(res => {
      const ns = res.nodes ?? []
      setNodes(ns)
      for (const n of ns) {
        if (n.lat != null && n.lon != null && !(n.lat === 0 && n.lon === 0)) {
          nodeLocRef.current.set(n.pubKey, [n.lat, n.lon])
        }
      }
    })
    api.packets(500, 0).then(res => {
      const sorted = [...(res.packets ?? [])].sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime())
      vcrBuffer.current = sorted
      // Build per-node byte size index from advert packets
      for (const p of sorted) {
        if (p.payloadType === 4 && p.byteSize > 0) {
          const pk = (p.decoded?.pubKey ?? '') as string
          if (pk) nodeByteSizeRef.current.set(pk, p.byteSize)
        }
      }
      drawTimeline()
    })
  }, [])

  // Sync markers with current filters
  useEffect(() => {
    const map = mapInstance.current; if (!map) return
    const now        = Date.now()
    const activeCut  = now - ACTIVE_MS
    const lhCut      = lastHeardFilter ? now - (LH_MS[lastHeardFilter] ?? 0) : 0

    const passes = (n: Node) => {
      if (n.lat == null || n.lon == null || (n.lat === 0 && n.lon === 0)) return false
      if (!roleVis[n.role as keyof typeof roleVis]) return false
      const lastTs = new Date(n.lastSeen).getTime()
      const active = lastTs > activeCut
      if (statusFilter === 'active' && !active) return false
      if (statusFilter === 'stale'  && active)  return false
      if (lhCut && lastTs < lhCut) return false
      if (byteSizeFilter !== 'all') {
        const bs = nodeByteSizeRef.current.get(n.pubKey)
        if (bs == null || bs !== parseInt(byteSizeFilter)) return false
      }
      return true
    }

    const cluster = clusterGroup.current

    // Remove markers that no longer match
    markersRef.current.forEach((m, key) => {
      const n = nodes.find(nd => nd.pubKey === key)
      if (!n || !passes(n)) { cluster?.removeLayer(m); markersRef.current.delete(key) }
    })

    // Add / update matching nodes
    const toAdd: L.Marker[] = []
    nodes.forEach(n => {
      if (!passes(n)) return
      const active = new Date(n.lastSeen).getTime() > activeCut
      const label  = showLabels ? (n.name || n.pubKey.slice(0, 8)) : undefined
      const icon   = makeIcon(n.role, active, label)
      const exist  = markersRef.current.get(n.pubKey)
      if (exist) { exist.setIcon(icon); return }
      const m = L.marker([n.lat!, n.lon!], { icon }).bindPopup(makePopup(n))
      m.on('click', () => selectNode(n))
      markersRef.current.set(n.pubKey, m)
      toAdd.push(m)
    })
    if (cluster && toAdd.length > 0) cluster.addLayers(toAdd)

    // Fit bounds to all visible markers on initial load
    if (markersRef.current.size > 0 && map.getZoom() === 2) {
      const latlngs = Array.from(markersRef.current.values()).map(m => m.getLatLng())
      if (latlngs.length > 0) map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 12 })
    }
  }, [nodes, roleVis, statusFilter, lastHeardFilter, byteSizeFilter, showLabels, theme.palette.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket
  useEffect(() => {
    const unsub = stream.subscribe(msg => {
      if (msg.type !== 'packet') return
      rateWindow.current.push(Date.now())
      vcrBuffer.current.push(msg.data)
      if (vcrBuffer.current.length > 2000) vcrBuffer.current.shift()
      drawTimeline()
      if (vcrMode.current === 'PAUSED') { vcrMissed.current++; setMissed(vcrMissed.current); return }
      if (vcrMode.current !== 'LIVE') return
      processPacket(msg.data)
    })
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const animatePacket = useCallback((lat: number, lon: number, color: string) => {
    const map = mapInstance.current; const layer = animLayer.current
    console.debug('[anim] animatePacket', lat, lon, 'map=', !!map, 'layer=', !!layer)
    if (!map || !layer) return
    const dot = L.circleMarker([lat, lon], { radius: 6, color, fillColor: color, fillOpacity: 0.8, weight: 1.5, opacity: 1 }).addTo(layer)
    let r = 6, op = 0.85
    const step = () => {
      r += 1.5; op -= 0.045
      if (op <= 0) { dot.remove(); return }
      dot.setRadius(r); dot.setStyle({ opacity: op, fillOpacity: op * 0.7 })
      animRAFs.current.push(requestAnimationFrame(step))
    }
    animRAFs.current.push(requestAnimationFrame(step))
  }, [])

  const flashMarker = useCallback((pk: string) => {
    const m  = markersRef.current.get(pk); if (!m) return
    const el = (m as unknown as { _icon?: HTMLElement })._icon; if (!el) return
    el.style.transition = 'transform 0.15s, filter 0.4s'
    el.style.transform  = 'scale(1.7)'; el.style.filter = 'brightness(2)'
    setTimeout(() => { el.style.transform = 'scale(1)'; el.style.filter = '' }, 150)
  }, [])

  // Resolve a short hex prefix (from pathJson) to a known node location + full pubKey
  const resolveHop = useCallback((prefix: string): { loc: [number, number]; pk: string } | null => {
    const up = prefix.toUpperCase()
    for (const [pk, loc] of nodeLocRef.current) {
      if (pk.toUpperCase().startsWith(up)) return { loc, pk }
    }
    return null
  }, [])

  // Sequential flow animation: traveling dot + line per segment, ripple+flash on arrival
  const animateFlow = useCallback((
    path: [number, number][],
    pubKeys: (string | null)[],
    color: string,
  ) => {
    const layer = animLayer.current
    console.debug('[anim] animateFlow called, layer=', !!layer, 'path=', path.length)
    if (!layer || path.length < 1) return
    const HOP_MS = 380

    // Source node fires immediately
    animatePacket(path[0][0], path[0][1], color)
    if (pubKeys[0]) flashMarker(pubKeys[0])

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]
      const to   = path[i + 1]
      const segDelay = i * HOP_MS

      setTimeout(() => {
        if (!animLayer.current) return
        const lyr = animLayer.current

        // Dashed line for the segment, fades after dot arrives
        const line = L.polyline([from, to], {
          color, weight: 2, opacity: 0.55, dashArray: '6 5',
        }).addTo(lyr)

        // Traveling dot
        const dot = L.circleMarker(from, {
          radius: 4, color, fillColor: '#fff', fillOpacity: 0.9, weight: 1.5, opacity: 1,
        }).addTo(lyr)

        const t0 = performance.now()
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / HOP_MS)
          const ep = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p  // ease in-out
          dot.setLatLng([from[0] + (to[0] - from[0]) * ep, from[1] + (to[1] - from[1]) * ep])
          if (p < 1) {
            animRAFs.current.push(requestAnimationFrame(step))
          } else {
            dot.remove()
            animatePacket(to[0], to[1], color)
            if (pubKeys[i + 1]) flashMarker(pubKeys[i + 1]!)
            let op = 0.55
            const fade = () => {
              op -= 0.04
              if (op <= 0) { line.remove(); return }
              line.setStyle({ opacity: op })
              animRAFs.current.push(requestAnimationFrame(fade))
            }
            setTimeout(() => animRAFs.current.push(requestAnimationFrame(fade)), 400)
          }
        }
        animRAFs.current.push(requestAnimationFrame(step))
      }, segDelay)
    }
  }, [animatePacket, flashMarker])

  const processPacket = useCallback((pkt: Packet) => {
    const dec = pkt.decoded; if (!dec) return
    const color  = TYPE_COLORS[pkt.payloadType] ?? md3.outline
    const pubKey = (dec.pubKey ?? '') as string
    console.debug('[anim] pkt', pkt.payloadType, 'pk=', pubKey, 'locCacheSize=', nodeLocRef.current.size, 'map=', !!mapInstance.current, 'layer=', !!animLayer.current)
    setLiveFeed(prev => [pkt, ...prev.slice(0, 19)])

    if (pkt.payloadType === 4 && pubKey) {
      if (pkt.byteSize > 0) nodeByteSizeRef.current.set(pubKey, pkt.byteSize)
      const lat  = dec.lat as number | undefined
      const lon  = dec.lon as number | undefined
      const name = dec.name as string | undefined
      if (lat != null && lon != null && !(lat === 0 && lon === 0)) {
        nodeLocRef.current.set(pubKey, [lat, lon])
        console.debug('[anim] cached loc', pubKey, lat, lon)
      }
      setNodes(prev => {
        const idx   = prev.findIndex(n => n.pubKey === pubKey)
        const flags = dec.flags as { type?: number } | undefined
        const role  = flags?.type === 2 ? 'repeater' : flags?.type === 3 ? 'room' : flags?.type === 4 ? 'sensor' : 'companion'
        const updated: Node = {
          pubKey, name: name ?? pubKey.slice(0, 8), role,
          lat: lat ?? (idx >= 0 ? prev[idx].lat : null),
          lon: lon ?? (idx >= 0 ? prev[idx].lon : null),
          lastSeen: pkt.firstSeen,
          firstSeen: idx >= 0 ? prev[idx].firstSeen : pkt.firstSeen,
          advertCount: idx >= 0 ? prev[idx].advertCount + 1 : 1,
        }
        if (idx >= 0) { const n = [...prev]; n[idx] = updated; return n }
        return [...prev, updated]
      })
    }

    // Build ordered path: sender + resolved hops, then run flow animation
    if (pubKey) {
      const senderLoc = nodeLocRef.current.get(pubKey)
      console.debug('[anim] senderLoc=', senderLoc, 'for pk=', pubKey)
      if (senderLoc) {
        const locs: [number, number][] = [senderLoc]
        const pks: (string | null)[]   = [pubKey]
        for (const prefix of (pkt.bestPath ?? [])) {
          const r = resolveHop(prefix)
          if (r) { locs.push(r.loc); pks.push(r.pk) }
        }
        console.debug('[anim] animateFlow path len=', locs.length)
        animateFlow(locs, pks, color)
      }
    }
  }, [md3.outline, resolveHop, animateFlow])

  // VCR
  const pause      = useCallback(() => { vcrMode.current = 'PAUSED'; vcrMissed.current = 0; setMode('PAUSED'); setMissed(0) }, [])
  const skipToLive = useCallback(() => {
    if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null }
    vcrMode.current = 'LIVE'; vcrPlayhead.current = -1; vcrMissed.current = 0
    setMode('LIVE'); setMissed(0); drawTimeline()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startReplay = useCallback((from?: number) => {
    if (replayTimer.current) clearInterval(replayTimer.current)
    const buf = vcrBuffer.current; if (!buf.length) return
    vcrPlayhead.current = from ?? 0; vcrMode.current = 'REPLAY'; vcrMissed.current = 0; setMode('REPLAY'); setMissed(0)
    replayTimer.current = setInterval(() => {
      if (vcrPlayhead.current >= buf.length - 1) { skipToLive(); return }
      vcrPlayhead.current++; processPacket(buf[vcrPlayhead.current]); drawTimeline()
    }, 1000 / vcrSpeed.current)
  }, [processPacket, skipToLive]) // eslint-disable-line react-hooks/exhaustive-deps

  const changeSpeed = (s: number) => { vcrSpeed.current = s; setSpeed(s); if (vcrMode.current === 'REPLAY') startReplay(vcrPlayhead.current) }

  const onTimelineClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = timelineCanvas.current; if (!canvas) return
    const pct = (e.clientX - canvas.getBoundingClientRect().left) / canvas.width
    startReplay(Math.round(pct * Math.max(vcrBuffer.current.length - 1, 0)))
  }, [startReplay])

  const drawTimeline = useCallback(() => {
    const canvas = timelineCanvas.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = md3.surfaceContainerHighest; ctx.fillRect(0, 0, W, H)
    const buf = vcrBuffer.current; if (!buf.length) return
    const minTs = new Date(buf[0].firstSeen).getTime(), maxTs = new Date(buf[buf.length - 1].firstSeen).getTime()
    const range = maxTs - minTs || 1; const BUCKETS = 80; const counts = new Array(BUCKETS).fill(0)
    for (const p of buf) { const i = Math.min(BUCKETS - 1, Math.floor((new Date(p.firstSeen).getTime() - minTs) / range * BUCKETS)); counts[i]++ }
    const maxC = Math.max(...counts, 1); const bw = W / BUCKETS
    ctx.fillStyle = alpha(md3.primary, 0.4)
    for (let i = 0; i < BUCKETS; i++) { const h = (counts[i] / maxC) * (H - 2); ctx.fillRect(i * bw, H - h, bw - 0.5, h) }
    const ph = vcrPlayhead.current < 0 ? W : (vcrPlayhead.current / Math.max(buf.length - 1, 1)) * W
    ctx.strokeStyle = md3.primary; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(ph, 0); ctx.lineTo(ph, H); ctx.stroke()
    if (vcrMode.current === 'LIVE') { ctx.fillStyle = '#22c55e'; ctx.fillRect(W - 4, 0, 4, H) }
  }, [md3.primary, md3.surfaceContainerHighest])

  const doQuickJump = useCallback(() => {
    const q = quickJump.trim().toLowerCase(); if (!q) return
    const n = nodes.find(nd => nd.lat != null && nd.lon != null && (nd.name.toLowerCase().includes(q) || nd.pubKey.toLowerCase().includes(q)))
    if (n && n.lat != null && n.lon != null) {
      mapInstance.current?.flyTo([n.lat, n.lon], 14, { duration: 1.2 })
      selectNode(n)
    }
  }, [quickJump, nodes, selectNode])

  function makePopup(n: Node) {
    const color = roleColor(n.role)
    return `<div style="font-family:system-ui;font-size:13px;min-width:170px;color:#1D1B20">
      <b style="font-size:14px">${n.name || n.pubKey.slice(0, 12)}</b>
      <div style="margin:4px 0;padding:2px 8px;border-radius:8px;display:inline-block;background:${color}22;color:${color};font-size:11px">${n.role}</div>
      <div style="font-size:11px;color:#49454F;margin-top:4px">Adverts: ${n.advertCount}<br/>Last: ${new Date(n.lastSeen).toLocaleString()}</div>
    </div>`
  }

  const panelBg = alpha(md3.surfaceContainer, 0.94)
  const totalVisible = markersRef.current.size

  return (
    <Box sx={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Map canvas */}
      <Box ref={mapDiv} sx={{ flex: 1 }} />

      {/* ── VCR bar ── */}
      <Paper elevation={3} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, borderRadius: 0, flexShrink: 0, borderTop: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerHigh }}>
        <Chip label={mode} size="small" sx={{
          background: mode === 'LIVE' ? alpha('#22c55e', 0.2) : mode === 'PAUSED' ? alpha('#f59e0b', 0.2) : alpha(md3.primary, 0.2),
          color:      mode === 'LIVE' ? '#22c55e'             : mode === 'PAUSED' ? '#f59e0b'             : md3.primary,
          fontWeight: 700, fontSize: 11,
        }} />

        {mode === 'LIVE' && <IconButton size="small" onClick={pause} sx={{ color: md3.onSurfaceVariant }}><PauseIcon fontSize="small" /></IconButton>}
        {mode === 'PAUSED' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Typography variant="caption" sx={{ color: '#f59e0b' }}>+{missed} missed</Typography>
            <Button size="small" variant="outlined" onClick={() => startReplay(Math.max(0, vcrBuffer.current.length - missed - 1))}>Replay</Button>
            <Button size="small" variant="contained" startIcon={<FastForwardIcon />} onClick={skipToLive}>Live</Button>
          </Box>
        )}
        {mode === 'REPLAY' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Button size="small" variant="contained" startIcon={<FastForwardIcon />} onClick={skipToLive}>Live</Button>
            <Typography variant="caption" sx={{ color: md3.primary }}>{vcrPlayhead.current + 1} / {vcrBuffer.current.length}</Typography>
          </Box>
        )}

        <ToggleButtonGroup exclusive value={speed} onChange={(_, s) => s && changeSpeed(s)} size="small" sx={{ ml: 1 }}>
          {SPEEDS.map(s => (
            <ToggleButton key={s} value={s} sx={{ fontSize: 10, px: 1, py: 0.25 }}>{s}×</ToggleButton>
          ))}
        </ToggleButtonGroup>

        <canvas ref={timelineCanvas} width={360} height={28} onClick={onTimelineClick}
          style={{ cursor: 'crosshair', borderRadius: 8, border: `1px solid ${md3.outlineVariant}`, flexShrink: 1, minWidth: 60, maxWidth: 360 }} />

        <Typography variant="caption" sx={{ ml: 'auto', color: md3.onSurfaceVariant, whiteSpace: 'nowrap' }}>
          <Box component="span" sx={{ color: '#22c55e' }}>{nodes.filter(n => n.lat != null).length}</Box> nodes ·{' '}
          <Box component="span" sx={{ color: '#f59e0b' }}>{pktRate}</Box>/min
        </Typography>
      </Paper>

      {/* ── Map Controls panel (top-left) ── */}
      <Paper elevation={4} sx={{
        position: 'absolute', top: 8, left: 8, zIndex: 1000,
        borderRadius: 2, minWidth: 210, maxWidth: { xs: 'calc(100vw - 16px)', sm: 230 },
        maxHeight: { xs: 'calc(50% - 40px)', md: 'calc(100% - 80px)' }, overflow: 'auto',
        background: panelBg, backdropFilter: 'blur(8px)',
      }}>
        {/* Header */}
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75,
          px: 1.5, py: 1, borderBottom: `1px solid ${alpha(md3.outlineVariant, 0.5)}`,
          position: 'sticky', top: 0, background: panelBg, zIndex: 1,
        }}>
          <MapIcon sx={{ fontSize: 15, color: md3.primary }} />
          <Typography variant="caption" sx={{ fontWeight: 700, color: md3.onSurface, flex: 1, fontSize: 12 }}>
            {t('map.controls')}
          </Typography>
          <IconButton size="small" onClick={() => setCtrlOpen(v => !v)} sx={{ color: md3.onSurfaceVariant, p: 0.25 }}>
            {ctrlOpen ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Box>

        {ctrlOpen && (
          <Box sx={{ px: 1.5, py: 1, display: 'flex', flexDirection: 'column', gap: 1.5 }}>

            {/* Node Types */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('map.nodeTypes')}</Typography>
              {ROLE_INFO.map(({ role, label, shape }) => {
                const color  = roleColor(role)
                const counts = typeCounts[role] ?? { active: 0, stale: 0 }
                return (
                  <Box key={role} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
                    <Checkbox
                      size="small"
                      checked={roleVis[role]}
                      onChange={e => setRoleVis(v => ({ ...v, [role]: e.target.checked }))}
                      sx={{ p: 0.25, color, '&.Mui-checked': { color } }}
                    />
                    <Typography sx={{ fontSize: 13, color, lineHeight: 1, width: 14, textAlign: 'center' }}>{shape}</Typography>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="caption" sx={{ color: md3.onSurface, fontSize: 11 }}>{label}</Typography>
                      <Typography variant="caption" sx={{ color: md3.outline, fontSize: 9, display: 'block', lineHeight: 1.2 }}>
                        {counts.active} active{counts.stale > 0 ? `, ${counts.stale} stale` : ''}
                      </Typography>
                    </Box>
                  </Box>
                )
              })}
            </Box>

            <Divider sx={{ opacity: 0.4 }} />

            {/* Byte Size */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('map.byteSize')}</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {(['all', '1', '2', '3'] as const).map(v => (
                  <Chip
                    key={v}
                    label={v === 'all' ? t('common.all') : `${v}-byte`}
                    size="small"
                    clickable
                    onClick={() => setByteSizeFilter(v)}
                    sx={{
                      fontSize: 10, height: 22,
                      background: byteSizeFilter === v ? alpha(md3.primary, 0.2) : 'transparent',
                      color: byteSizeFilter === v ? md3.primary : md3.outline,
                      border: `1px solid ${byteSizeFilter === v ? md3.primary : alpha(md3.outlineVariant, 0.6)}`,
                    }}
                  />
                ))}
              </Box>
            </Box>

            <Divider sx={{ opacity: 0.4 }} />

            {/* Display */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('map.display')}</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Checkbox
                  size="small"
                  checked={showLabels}
                  onChange={e => setShowLabels(e.target.checked)}
                  sx={{ p: 0.25, color: md3.primary, '&.Mui-checked': { color: md3.primary } }}
                />
                <Typography variant="caption" sx={{ color: md3.onSurface, fontSize: 11 }}>{t('map.hashPrefixLabels')}</Typography>
              </Box>
            </Box>

            <Divider sx={{ opacity: 0.4 }} />

            {/* Status */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('common.status')}</Typography>
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                {(['all', 'active', 'stale'] as const).map(s => (
                  <Chip
                    key={s}
                    label={s === 'all' ? t('common.all') : s === 'active' ? `🟢 ${t('common.active')}` : `⚪ ${t('common.stale')}`}
                    size="small"
                    clickable
                    onClick={() => setStatusFilter(s)}
                    sx={{
                      fontSize: 10, height: 22,
                      background: statusFilter === s
                        ? alpha(s === 'active' ? '#22c55e' : s === 'stale' ? md3.error : md3.outline, 0.2)
                        : 'transparent',
                      color: statusFilter === s
                        ? (s === 'active' ? '#22c55e' : s === 'stale' ? md3.error : md3.onSurface)
                        : md3.outline,
                      border: `1px solid ${statusFilter === s
                        ? (s === 'active' ? '#22c55e' : s === 'stale' ? md3.error : md3.outline)
                        : alpha(md3.outlineVariant, 0.6)}`,
                    }}
                  />
                ))}
              </Box>
            </Box>

            <Divider sx={{ opacity: 0.4 }} />

            {/* Last Heard */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('nodes.lastHeard')}</Typography>
              <Select
                size="small"
                value={lastHeardFilter}
                onChange={e => setLastHeardFilter(e.target.value)}
                sx={{ width: '100%', height: 28, fontSize: 11 }}
              >
                {LH_OPTIONS.map(o => (
                  <MenuItem key={o.value} value={o.value} sx={{ fontSize: 12 }}>{o.label}</MenuItem>
                ))}
              </Select>
            </Box>

            <Divider sx={{ opacity: 0.4 }} />

            {/* Quick Jump */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('map.quickJump')}</Typography>
              <TextField
                size="small"
                placeholder={t('map.nodeNamePlaceholder')}
                value={quickJump}
                onChange={e => setQuickJump(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doQuickJump()}
                sx={{ width: '100%', '& input': { fontSize: 11, py: 0.75 } }}
              />
              <Button
                size="small"
                variant="outlined"
                fullWidth
                onClick={doQuickJump}
                sx={{ mt: 0.75, fontSize: 11 }}
              >
                {t('map.jump')}
              </Button>
            </Box>

            {/* Visible count */}
            <Typography variant="caption" sx={{ color: md3.outline, fontSize: 9, textAlign: 'center', pb: 0.5 }}>
              {t('map.nodesVisible', { count: totalVisible })}
            </Typography>
          </Box>
        )}
      </Paper>

      {/* Collapsed toggle */}
      {!ctrlOpen && (
        <Tooltip title={t('map.controls')}>
          <IconButton
            size="small"
            onClick={() => setCtrlOpen(true)}
            sx={{ position: 'absolute', top: 8, left: 8, zIndex: 1000, background: panelBg, border: `1px solid ${md3.outlineVariant}`, borderRadius: 2, color: md3.primary, '&:hover': { background: alpha(md3.primary, 0.12) } }}
          >
            <MapIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
      {/* ── Live feed (bottom-left) ── */}
      {showFeed && (
        <Paper elevation={4} sx={{ position: 'absolute', bottom: 64, left: 8, zIndex: 1000, p: 1.5, borderRadius: 2, minWidth: 260, maxWidth: 'calc(100vw - 16px)', maxHeight: 240, overflow: 'auto', background: panelBg }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
            <Typography variant="overline" sx={{ color: md3.onSurfaceVariant, lineHeight: 1 }}>{t('map.liveFeed')}</Typography>
            <IconButton size="small" onClick={() => setShowFeed(false)} sx={{ color: md3.outline, p: 0.25 }}><CloseIcon sx={{ fontSize: 14 }} /></IconButton>
          </Box>
          {liveFeed.length === 0 && <Typography variant="caption" sx={{ color: md3.outline }}>{t('map.waiting')}</Typography>}
          {liveFeed.map(pkt => {
            const dec = pkt.decoded; const color = TYPE_COLORS[pkt.payloadType] ?? md3.outline; const icon = TYPE_ICONS[pkt.payloadType] ?? '·'
            const name = (dec?.name ?? dec?.sender ?? dec?.channel) as string | undefined
            return (
              <Box key={pkt.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.35, borderBottom: `1px solid ${alpha(md3.outlineVariant, 0.4)}` }}>
                <Box component="span" sx={{ fontSize: 14 }}>{icon}</Box>
                <Typography variant="caption" sx={{ color, fontWeight: 700 }}>{PAYLOAD_NAMES[pkt.payloadType] ?? pkt.payloadType}</Typography>
                {name && <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Typography>}
                <Typography variant="caption" sx={{ color: md3.outline, flexShrink: 0 }}>{formatDistanceToNow(new Date(pkt.firstSeen), { addSuffix: true, locale: dateLocale })}</Typography>
              </Box>
            )
          })}
        </Paper>
      )}
      {!showFeed && (
        <Box
          onClick={() => setShowFeed(true)}
          sx={{
            position: 'absolute', bottom: 64, left: 8, zIndex: 1000,
            px: 1.25, py: 0.5, borderRadius: 2, cursor: 'pointer',
            background: panelBg, backdropFilter: 'blur(8px)',
            border: `1px solid ${alpha(md3.outlineVariant, 0.6)}`,
            '&:hover': { background: alpha(md3.surfaceContainerHigh, 0.96), borderColor: md3.outline },
          }}
        >
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontWeight: 600, fontSize: 11 }}>
            {t('map.liveFeed')}
          </Typography>
        </Box>
      )}

      {/* ── Node detail sidebar ── */}
      {selected && (
        <NodeDetailPanel
          selected={selected}
          overview={overview}
          rf={rf}
          onClose={() => { setSelected(null); setOverview(null); setRF(null) }}
          paperSx={{
            position: 'absolute', top: 0, right: 0, bottom: 52,
            zIndex: 999, width: 460, borderRadius: 0,
            borderLeft: `1px solid ${md3.outlineVariant}`,
            overflow: 'auto', background: panelBg,
          }}
        />
      )}
    </Box>
  )
}
