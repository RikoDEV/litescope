import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
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
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MapIcon from '@mui/icons-material/Map'
import LayersIcon from '@mui/icons-material/Layers'
import { useTranslation } from 'react-i18next'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Node, NodeOverview, Packet, RFStats, ScopeRegion } from '../types'
import NodeDetailPanel from '../components/NodeDetailPanel'
import RegionFilter from '../components/RegionFilter'
import { hasValidLocation } from '../utils/geo'
import { escapeHtml } from '../utils/html'
import { passesGeo, selectedCountries } from '../utils/regions'
import { ROLE_GLYPH, roleColor as roleColorFn, roleMarkerSvg } from '../utils/roles'

// Fix leaflet icon
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
})

const ACTIVE_MS = 24 * 3600e3
const SCOPE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316']

const LH_MS: Record<string, number> = {
  '1h': 3600e3, '6h': 6*3600e3, '24h': 24*3600e3, '7d': 7*24*3600e3, '30d': 30*24*3600e3,
}

// Canonical role symbols/colours/markers are shared app-wide via utils/roles.
const ROLE_SHAPES = ROLE_GLYPH


export default function MapView() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()


  const LH_OPTIONS = [
    { value: '',    label: t('common.anyTime') },
    { value: '1h',  label: '1h' },
    { value: '6h',  label: '6h' },
    { value: '24h', label: '24h' },
    { value: '7d',  label: '7d' },
    { value: '30d', label: '30d' },
  ]

  const ROLE_INFO: { role: 'repeater'|'companion'|'room'|'sensor'; label: string; shape: string }[] = [
    { role: 'repeater',  label: t('map.repeaters'),   shape: ROLE_SHAPES.repeater ?? '◆' },
    { role: 'companion', label: t('map.companions'),  shape: ROLE_SHAPES.companion ?? '●' },
    { role: 'room',      label: t('map.roomServers'), shape: ROLE_SHAPES.room ?? '⬡' },
    { role: 'sensor',    label: t('map.sensors'),     shape: ROLE_SHAPES.sensor ?? '▲' },
  ]

  const mapDiv       = useRef<HTMLDivElement>(null)
  const mapInstance  = useRef<L.Map | null>(null)
  const clusterGroup = useRef<L.MarkerClusterGroup | null>(null)
  const markersRef   = useRef<Map<string, L.Marker>>(new Map())
  const scopeLayerRef = useRef<L.LayerGroup | null>(null)

  const [nodes,    setNodes]    = useState<Node[]>([])
  const [scopeRegions, setScopeRegions] = useState<ScopeRegion[]>([])
  const [selected, setSelected] = useState<Node | null>(null)
  const [overview, setOverview] = useState<NodeOverview | null>(null)
  const [rf,       setRF]       = useState<RFStats | null>(null)
  const [ctrlOpen, setCtrlOpen] = useState(true)

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
  const [showScopeRegions, setShowScopeRegions] = useState(false)
  const [scopeFilter, setScopeFilter] = useState('all')
  const [showLabels, setShowLabels] = useState(false)
  const [quickJump, setQuickJump] = useState('')
  const [iatas, setIatas] = useState<string[]>([])
  const [regionFilter, setRegionFilter] = useState<Set<string>>(new Set())
  // Geographic country set derived from the selected regions (strict geo-lock by node position)
  const geoCountries = useMemo(() => new Set(selectedCountries(regionFilter)), [regionFilter])

  // pubKey → byte size of its most recent advert packet (built from VCR buffer)
  const nodeByteSizeRef = useRef<Map<string, number>>(new Map())

  const roleColor = (r: string) => roleColorFn(r, md3)
  const scopeColor = useCallback((scope: string) => {
    if (scope === 'unknown') return md3.outline
    let hash = 0
    for (let i = 0; i < scope.length; i++) hash = (hash * 31 + scope.charCodeAt(i)) | 0
    return SCOPE_COLORS[Math.abs(hash) % SCOPE_COLORS.length] ?? SCOPE_COLORS[0]!
  }, [md3.outline])

  // Shared ref so the markercluster iconCreateFunction (a static closure) can read live theme values
  const clusterCtxRef = useRef({ mode: theme.palette.mode, colors: { repeater: md3.primary, companion: md3.tertiary, room: '#22c55e', sensor: '#f59e0b' }, outline: md3.outline, surface: md3.surfaceContainerHighest, onSurface: md3.onSurface })

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
    const svg    = roleMarkerSvg(role, color, active ? 1 : 0.35, stroke)
    const isDark = theme.palette.mode === 'dark'
    const labelBg     = isDark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.88)'
    const labelBorder = isDark ? '' : `border:1px solid ${color}44;`
    const html  = label
      ? `<div style="position:relative;display:inline-block">${svg}<span style="position:absolute;left:22px;top:3px;font-size:9px;color:${color};white-space:nowrap;font-family:monospace;background:${labelBg};padding:0 3px;border-radius:2px;${labelBorder}">${escapeHtml(label)}</span></div>`
      : svg
    return L.divIcon({ html, className: '', iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -13] })
  }

  const tileLayerRef = useRef<L.TileLayer | null>(null)

  // Map init
  useEffect(() => {
    const el = mapDiv.current
    if (!el || mapInstance.current) return
    // Guard against React StrictMode double-invoke leaving a stale leaflet container
    if ((el as unknown as Record<string, unknown>)._leaflet_id) return
    const map = L.map(el, { center: [20, 0], zoom: 2, zoomControl: false, maxZoom: 19 })
    const cluster = L.markerClusterGroup({
      disableClusteringAtZoom: 11,
      maxClusterRadius: 60,
      iconCreateFunction: (c) => {
        const ctx = clusterCtxRef.current
        const isDark = ctx.mode === 'dark'
        const children = c.getAllChildMarkers()
        const counts: Record<string, number> = {}
        children.forEach(m => { const r = (m as any)._nodeRole ?? 'companion'; counts[r] = (counts[r] ?? 0) + 1 })
        const total = children.length
        const roles: Array<'repeater' | 'companion' | 'room' | 'sensor'> = ['repeater', 'companion', 'room', 'sensor']
        const parts = roles.filter(r => (counts[r] ?? 0) > 0)
          .map(r => `<span style="color:${ctx.colors[r]}">${ROLE_SHAPES[r]}${counts[r]}</span>`).join(' ')
        const bg     = isDark ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.96)'
        const border = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.13)'
        const fg     = isDark ? '#f1f5f9' : '#0f172a'
        const sub    = isDark ? '#94a3b8' : '#475569'
        const html = `<div style="position:absolute;transform:translate(-50%,-50%);background:${bg};border:1.5px solid ${border};border-radius:8px;padding:4px 8px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.22);font-family:system-ui,sans-serif;line-height:1;white-space:nowrap"><div style="font-size:13px;font-weight:700;color:${fg};margin-bottom:2px">${total}</div>${parts ? `<div style="font-size:8px;color:${sub};letter-spacing:0.02em">${parts}</div>` : ''}</div>`
        return L.divIcon({ html, className: '', iconSize: [0, 0], iconAnchor: [0, 0] })
      },
    })
    cluster.addTo(map)
    scopeLayerRef.current = L.layerGroup().addTo(map)
    clusterGroup.current = cluster
    mapInstance.current = map
    return () => { map.remove(); mapInstance.current = null; clusterGroup.current = null; scopeLayerRef.current = null }
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
    // Refresh cluster icons so they pick up the new theme colours
    clusterCtxRef.current = { mode: theme.palette.mode, colors: { repeater: md3.primary, companion: md3.tertiary, room: '#22c55e', sensor: '#f59e0b' }, outline: md3.outline, surface: md3.surfaceContainerHighest, onSurface: md3.onSurface }
    clusterGroup.current?.refreshClusters()
  }, [theme.palette.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load nodes + seed byte-size map from recent packet history
  useEffect(() => {
    Promise.all([api.nodes(), api.packets(500, 0)]).then(([nodesRes, pktsRes]) => {
      for (const p of pktsRes.packets ?? []) {
        if (p.payloadType === 4 && p.hopSize && p.hopSize > 0 && p.decoded?.pubKey)
          nodeByteSizeRef.current.set(p.decoded.pubKey as string, p.hopSize!)
      }
      setNodes(nodesRes.nodes ?? [])
    })
    api.iatas().then(c => setIatas((c ?? []).sort())).catch(() => {})
  }, [])

  const scopeParams = useMemo(() => {
    const hours = lastHeardFilter === '1h' ? 1 :
                  lastHeardFilter === '6h' ? 6 :
                  lastHeardFilter === '24h' ? 24 :
                  lastHeardFilter === '7d' ? 168 : undefined
    return {
      hours,
      regions: [...regionFilter],
    }
  }, [lastHeardFilter, regionFilter])

  useEffect(() => {
    if (!showScopeRegions) return
    let cancelled = false
    const load = () => {
      api.analyticsScopeRegions(scopeParams)
        .then(regions => { if (!cancelled) setScopeRegions(regions ?? []) })
        .catch(() => { if (!cancelled) setScopeRegions([]) })
    }
    load()
    const id = window.setInterval(load, 30_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [showScopeRegions, scopeParams])

  const scopeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of scopeRegions) for (const s of r.scopes) set.add(s.scope)
    return [...set].sort((a, b) => a === 'unknown' ? 1 : b === 'unknown' ? -1 : a.localeCompare(b))
  }, [scopeRegions])

  useEffect(() => {
    const layer = scopeLayerRef.current
    if (!layer) return
    layer.clearLayers()
    if (!showScopeRegions) return

    const filtered = scopeRegions
      .map(region => {
        if (scopeFilter === 'all') return region
        const scope = region.scopes.find(s => s.scope === scopeFilter)
        if (!scope) return null
        return {
          ...region,
          pktCount: scope.pktCount,
          obsCount: scope.obsCount,
          dominantScope: scope.scope,
          scopes: [scope],
        }
      })
      .filter((r): r is ScopeRegion => Boolean(r))

    const maxObs = Math.max(1, ...filtered.map(r => r.obsCount))
    for (const region of filtered) {
      const color = scopeColor(region.dominantScope)
      const radius = 25_000 + Math.sqrt(region.obsCount / maxObs) * 260_000
      const topScopes = region.scopes.slice(0, 4)
        .map(s => `<div style="display:flex;justify-content:space-between;gap:12px"><span>${escapeHtml(s.scope)}</span><b>${s.obsCount.toLocaleString()}</b></div>`)
        .join('')
      const circle = L.circle([region.lat, region.lon], {
        radius,
        color,
        weight: 1.5,
        opacity: 0.85,
        fillColor: color,
        fillOpacity: 0.16,
      }).bindTooltip(
        `<div style="font-family:system-ui;min-width:160px">
          <b>${escapeHtml(region.region)}</b>
          <div style="margin:2px 0;color:#64748b">${region.observerCount} observer${region.observerCount === 1 ? '' : 's'} · ${region.obsCount.toLocaleString()} observations</div>
          <div style="color:${color};font-weight:700">Dominant: ${escapeHtml(region.dominantScope)}</div>
          ${topScopes ? `<div style="margin-top:4px">${topScopes}</div>` : ''}
        </div>`,
        { sticky: true },
      )
      layer.addLayer(circle)
    }
  }, [showScopeRegions, scopeRegions, scopeFilter, scopeColor])

  // Sync markers with current filters
  useEffect(() => {
    const map = mapInstance.current; if (!map) return
    const now        = Date.now()
    const activeCut  = now - ACTIVE_MS
    const lhCut      = lastHeardFilter ? now - (LH_MS[lastHeardFilter] ?? 0) : 0

    const passes = (n: Node) => {
      if (!hasValidLocation(n.lat, n.lon)) return false
      if (!roleVis[n.role as keyof typeof roleVis]) return false
      if (!passesGeo(n.country, geoCountries)) return false
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
      if (exist) { exist.setIcon(icon); (exist as any)._nodeRole = n.role; return }
      const m = L.marker([n.lat!, n.lon!], { icon }).bindPopup(makePopup(n));
      (m as any)._nodeRole = n.role
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
  }, [nodes, roleVis, statusFilter, lastHeardFilter, byteSizeFilter, showLabels, geoCountries, theme.palette.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket
  useEffect(() => {
    const unsub = stream.subscribe(msg => {
      if (msg.type !== 'packet') return
      processPacket(msg.data)
    })
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const processPacket = useCallback((pkt: Packet) => {
    const dec = pkt.decoded; if (!dec) return
    if (pkt.payloadType === 4 && dec.pubKey) {
      const pubKey = dec.pubKey as string
      if (pkt.hopSize && pkt.hopSize > 0) nodeByteSizeRef.current.set(pubKey, pkt.hopSize)
      const lat  = dec.lat as number | undefined
      const lon  = dec.lon as number | undefined
      const name = dec.name as string | undefined
      setNodes(prev => {
        const idx   = prev.findIndex(n => n.pubKey === pubKey)
        const existing = idx >= 0 ? prev[idx] : undefined
        const flags = dec.flags as { type?: number } | undefined
        const role  = flags?.type === 2 ? 'repeater' : flags?.type === 3 ? 'room' : flags?.type === 4 ? 'sensor' : 'companion'
        // Merge the regions that heard this advert so live nodes stay filterable
        const regions = pkt.regions?.length
          ? [...new Set([...(existing?.regions ?? []), ...pkt.regions])].sort()
          : existing?.regions
        const updated: Node = {
          pubKey, name: name ?? pubKey.slice(0, 8), role,
          lat: lat ?? existing?.lat ?? null,
          lon: lon ?? existing?.lon ?? null,
          // Country resolved backend-side from the advert position (for geo-lock)
          country: pkt.country ?? existing?.country,
          lastSeen: pkt.firstSeen,
          firstSeen: existing?.firstSeen ?? pkt.firstSeen,
          advertCount: existing ? existing.advertCount + 1 : 1,
          regions,
        }
        if (idx >= 0) { const n = [...prev]; n[idx] = updated; return n }
        return [...prev, updated]
      })
    }
  }, [])

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
    const title = escapeHtml(n.name || n.pubKey.slice(0, 12))
    const role  = escapeHtml(n.role)
    const adverts = Number.isFinite(n.advertCount) ? n.advertCount : 0
    const last = escapeHtml(new Date(n.lastSeen).toLocaleString())
    return `<div style="font-family:system-ui;font-size:13px;min-width:170px;color:#1D1B20">
      <b style="font-size:14px">${title}</b>
      <div style="margin:4px 0;padding:2px 8px;border-radius:8px;display:inline-block;background:${color}22;color:${color};font-size:11px">${role}</div>
      <div style="font-size:11px;color:#49454F;margin-top:4px">Adverts: ${adverts}<br/>Last: ${last}</div>
    </div>`
  }

  const panelBg = alpha(md3.surfaceContainer, 0.94)
  const totalVisible = markersRef.current.size

  return (
    <Box sx={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Map canvas */}
      <Box ref={mapDiv} sx={{ flex: 1 }} />


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
          px: 1.5, py: 1, borderBottom: `1px solid ${alpha(md3.outlineVariant, 0.2)}`,
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

            {/* Region */}
            {iatas.length > 0 && (
              <>
                <Box>
                  <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>{t('common.region')}</Typography>
                  <RegionFilter iatas={iatas} value={regionFilter} onChange={setRegionFilter} lock={false} onLockChange={() => {}} showLabel={false} showLock={false} />
                </Box>
                <Divider sx={{ opacity: 0.4 }} />
              </>
            )}

            {/* Scoped regions overlay */}
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 0.5 }}>Layers</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: showScopeRegions ? 0.75 : 0 }}>
                <Checkbox
                  size="small"
                  checked={showScopeRegions}
                  onChange={e => setShowScopeRegions(e.target.checked)}
                  sx={{ p: 0.25, color: md3.primary, '&.Mui-checked': { color: md3.primary } }}
                />
                <LayersIcon sx={{ fontSize: 14, color: md3.primary }} />
                <Typography variant="caption" sx={{ color: md3.onSurface, fontSize: 11, flex: 1 }}>Scoped regions</Typography>
                {showScopeRegions && (
                  <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>{scopeRegions.length}</Typography>
                )}
              </Box>
              {showScopeRegions && (
                <Select
                  size="small"
                  value={scopeFilter}
                  onChange={e => setScopeFilter(e.target.value)}
                  sx={{ width: '100%', height: 28, fontSize: 11 }}
                >
                  <MenuItem value="all" sx={{ fontSize: 12 }}>All scopes</MenuItem>
                  {scopeOptions.map(scope => (
                    <MenuItem key={scope} value={scope} sx={{ fontSize: 12 }}>
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                        <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', background: scopeColor(scope) }} />
                        {scope}
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
              )}
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
                      border: `1px solid ${byteSizeFilter === v ? md3.primary : alpha(md3.outlineVariant, 0.25)}`,
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
                        : alpha(md3.outlineVariant, 0.25)}`,
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
            sx={{ position: 'absolute', top: 8, left: 8, zIndex: 1000, background: panelBg, border: `1px solid ${alpha(md3.outlineVariant, 0.3)}`, borderRadius: 2, color: md3.primary, '&:hover': { background: alpha(md3.primary, 0.12) } }}
          >
            <MapIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
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
