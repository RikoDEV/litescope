import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Chip from '@mui/material/Chip'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Collapse from '@mui/material/Collapse'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import PauseIcon from '@mui/icons-material/Pause'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import TuneIcon from '@mui/icons-material/Tune'
import CloseIcon from '@mui/icons-material/Close'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Packet, PacketDetail } from '../types'
import { PAYLOAD_NAMES, ROUTE_NAMES } from '../types'

const PAGE = 100

const TIME_WINDOWS = [
  { label: 'All', ms: 0 },
  { label: '15m', ms: 15 * 60e3 },
  { label: '1h',  ms: 60 * 60e3 },
  { label: '6h',  ms: 6 * 60 * 60e3 },
  { label: '24h', ms: 24 * 60 * 60e3 },
]

const ALL_TYPES = [4, 5, 2, 3, 9, 8, 0, 1, 6, 7, 10, 11, 15]
const ROUTE_LABELS: Record<number, string> = { 0: 'T-FLOOD', 1: 'FLOOD', 2: 'DIRECT', 3: 'T-DIRECT' }
type SortCol = 'id' | 'payloadType' | 'routeType' | 'obsCount' | 'firstSeen'

export default function Packets() {
  const theme = useTheme()
  const md3   = theme.palette.md3
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()

  const [packets, setPackets]   = useState<Packet[]>([])
  const [total, setTotal]       = useState(0)
  const [selected, setSelected] = useState<PacketDetail | null>(null)
  const [paused, setPaused]     = useState(false)
  const [loading, setLoading]   = useState(true)
  const [showFilters, setShowFilters] = useState(false)
  const offsetRef = useRef(0)

  const [search, setSearch]           = useState('')
  const [typeFilter, setTypeFilter]   = useState<Set<number>>(new Set())
  const [routeFilter, setRouteFilter] = useState<number | null>(null)
  const [minObs, setMinObs]           = useState(1)
  const [windowMs, setWindowMs]       = useState(0)
  const [sortCol, setSortCol]         = useState<SortCol>('firstSeen')
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('desc')

  const typeColor = (pt: number) => {
    const map: Record<number, string> = {
      4: md3.primary, 5: md3.tertiary, 2: '#f59e0b', 3: '#22c55e',
      9: md3.tertiary, 8: '#14b8a6',
    }
    return map[pt] ?? md3.outline
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const cutoff = windowMs > 0 ? Date.now() - windowMs : 0
    let list = packets.filter(p => {
      if (windowMs > 0 && new Date(p.firstSeen).getTime() < cutoff) return false
      if (typeFilter.size > 0 && !typeFilter.has(p.payloadType)) return false
      if (routeFilter !== null && p.routeType !== routeFilter) return false
      if (p.obsCount < minObs) return false
      if (q) {
        const d = p.decoded
        return p.hash.includes(q)
          || (d?.name as string | undefined)?.toLowerCase().includes(q)
          || (d?.sender as string | undefined)?.toLowerCase().includes(q)
          || (d?.text as string | undefined)?.toLowerCase().includes(q)
          || (d?.pubKey as string | undefined)?.includes(q)
      }
      return true
    })
    return [...list].sort((a, b) => {
      const [va, vb] =
        sortCol === 'payloadType' ? [a.payloadType, b.payloadType] :
        sortCol === 'routeType'   ? [a.routeType,   b.routeType]   :
        sortCol === 'obsCount'    ? [a.obsCount,     b.obsCount]    :
        sortCol === 'id'          ? [a.id,           b.id]          :
        [new Date(a.firstSeen).getTime(), new Date(b.firstSeen).getTime()]
      return sortDir === 'asc' ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0)
    })
  }, [packets, typeFilter, routeFilter, minObs, search, windowMs, sortCol, sortDir])

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir(col === 'firstSeen' ? 'desc' : 'asc') }
  }

  const load = useCallback(async (offset = 0) => {
    setLoading(true)
    try {
      const res = await api.packets(PAGE, offset)
      setTotal(res.total)
      if (offset === 0) setPackets(res.packets ?? [])
      else setPackets(p => [...p, ...(res.packets ?? [])])
      offsetRef.current = offset + (res.packets?.length ?? 0)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load(0) }, [load])

  // Auto-select packet when ?hash= is present in URL
  useEffect(() => {
    const hash = searchParams.get('hash')
    if (!hash) return
    api.packet(hash).then(detail => {
      setSelected(detail)
      setSearchParams({}, { replace: true })
    }).catch(() => setSearchParams({}, { replace: true }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return stream.subscribe(msg => {
      if (msg.type === 'packet') {
        setPackets(prev => [msg.data, ...prev.slice(0, 999)])
        setTotal(t => t + 1)
      }
    })
  }, [])

  useEffect(() => { stream.setPaused(paused) }, [paused])

  const selectPacket = async (p: Packet) => {
    if (selected?.hash === p.hash) { setSelected(null); return }
    setSelected(await api.packet(p.hash))
  }

  const activeFilters = (typeFilter.size > 0 ? 1 : 0) + (routeFilter !== null ? 1 : 0) + (minObs > 1 ? 1 : 0) + (search ? 1 : 0) + (windowMs > 0 ? 1 : 0)
  const clearFilters = () => { setSearch(''); setTypeFilter(new Set()); setRouteFilter(null); setMinObs(1); setWindowMs(0) }

  const sortArrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  return (
    <Box sx={{ display: 'flex', height: '100%', background: md3.background }}>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* ── Toolbar ── */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25, borderBottom: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow, flexShrink: 0 }}>
          <Typography variant="body2" sx={{ color: md3.onSurfaceVariant }}>
            <Box component="span" sx={{ color: md3.onSurface, fontWeight: 700 }}>
              {filtered.length !== packets.length ? filtered.length.toLocaleString() : total.toLocaleString()}
            </Box>
            {filtered.length !== packets.length && <Box component="span" sx={{ color: md3.outline }}> / {total.toLocaleString()}</Box>}
            {' '}{t('common.packets').toLowerCase()}
          </Typography>

          {/* Time window */}
          <ToggleButtonGroup exclusive size="small" value={windowMs} onChange={(_, v) => v !== null && setWindowMs(v)} sx={{ ml: 1 }}>
            {TIME_WINDOWS.map(tw => (
              <ToggleButton key={tw.ms} value={tw.ms} sx={{ fontSize: 11, px: 1.5, py: 0.5, color: md3.onSurfaceVariant, borderColor: md3.outlineVariant, '&.Mui-selected': { background: alpha(md3.primary, 0.15), color: md3.primary } }}>
                {tw.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <Box sx={{ flex: 1 }} />

          {/* Search */}
          <TextField
            size="small" placeholder={t('packets.searchPlaceholder')}
            value={search} onChange={e => setSearch(e.target.value)}
            sx={{ width: 240 }}
            slotProps={{ input: { endAdornment: search ? <IconButton size="small" onClick={() => setSearch('')}><CloseIcon sx={{ fontSize: 14 }} /></IconButton> : null } }}
          />

          {/* Filters button */}
          <Button
            variant={showFilters || activeFilters > 0 ? 'contained' : 'outlined'}
            size="small" startIcon={<TuneIcon />}
            onClick={() => setShowFilters(v => !v)}
            sx={{ minWidth: 0, px: 1.5 }}
          >
            {t('common.filters')} {activeFilters > 0 && `(${activeFilters})`}
          </Button>

          <Button variant={paused ? 'contained' : 'outlined'} size="small"
            startIcon={paused ? <PlayArrowIcon /> : <PauseIcon />}
            onClick={() => setPaused(p => !p)}>
            {paused ? t('common.resume') : t('common.pause')}
          </Button>

          <IconButton size="small" onClick={() => load(0)} sx={{ color: md3.onSurfaceVariant }}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Box>

        {/* ── Filter panel ── */}
        <Collapse in={showFilters}>
          <Box sx={{ px: 2, py: 1.5, background: md3.surfaceContainerHighest, borderBottom: `1px solid ${md3.outlineVariant}` }}>
            {/* Type chips */}
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, width: 40, flexShrink: 0 }}>{t('common.type')}</Typography>
              {ALL_TYPES.map(pt => {
                const name = PAYLOAD_NAMES[pt]
                if (!name) return null
                const active = typeFilter.has(pt)
                const color = typeColor(pt)
                return (
                  <Chip key={pt} label={name} size="small" clickable
                    onClick={() => setTypeFilter(prev => { const n = new Set(prev); n.has(pt) ? n.delete(pt) : n.add(pt); return n })}
                    sx={{
                      background: active ? alpha(color, 0.2) : 'transparent',
                      color: active ? color : md3.onSurfaceVariant,
                      border: `1px solid ${active ? color : md3.outlineVariant}`,
                    }}
                  />
                )
              })}
              {typeFilter.size > 0 && <Chip label={t('common.clear')} size="small" onDelete={() => setTypeFilter(new Set())} sx={{ color: md3.outline }} />}
            </Box>

            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Route */}
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('common.route')}</Typography>
                {([null, 0, 1, 2, 3] as (number | null)[]).map(rt => (
                  <Chip key={String(rt)} label={rt === null ? t('common.all') : ROUTE_LABELS[rt]} size="small" clickable
                    onClick={() => setRouteFilter(routeFilter === rt ? null : rt)}
                    sx={{ background: routeFilter === rt ? alpha(md3.secondary, 0.2) : 'transparent', color: routeFilter === rt ? md3.secondary : md3.onSurfaceVariant, border: `1px solid ${routeFilter === rt ? md3.secondary : md3.outlineVariant}` }}
                  />
                ))}
              </Box>

              {/* Min obs */}
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('packets.minObs')}</Typography>
                {[1, 2, 3, 5].map(n => (
                  <Chip key={n} label={n === 1 ? t('common.any') : `${n}+`} size="small" clickable
                    onClick={() => setMinObs(n)}
                    sx={{ background: minObs === n ? alpha(md3.tertiary, 0.2) : 'transparent', color: minObs === n ? md3.tertiary : md3.onSurfaceVariant, border: `1px solid ${minObs === n ? md3.tertiary : md3.outlineVariant}` }}
                  />
                ))}
              </Box>

              {activeFilters > 0 && (
                <Button size="small" color="error" onClick={clearFilters} startIcon={<CloseIcon />}>{t('common.clearAll')}</Button>
              )}
            </Box>
          </Box>
        </Collapse>

        {/* ── Active filter pills ── */}
        {!showFilters && activeFilters > 0 && (
          <Box sx={{ display: 'flex', gap: 0.75, px: 2, py: 0.75, background: md3.surfaceContainerHighest, borderBottom: `1px solid ${md3.outlineVariant}`, flexWrap: 'wrap', flexShrink: 0 }}>
            {search && <Chip label={`"${search}"`} size="small" onDelete={() => setSearch('')} sx={{ color: md3.primary, borderColor: md3.primaryContainer }} variant="outlined" />}
            {[...typeFilter].map(t => <Chip key={t} label={PAYLOAD_NAMES[t] ?? t} size="small" onDelete={() => setTypeFilter(p => { const n = new Set(p); n.delete(t); return n })} sx={{ color: typeColor(t) }} variant="outlined" />)}
            {routeFilter !== null && <Chip label={ROUTE_LABELS[routeFilter]} size="small" onDelete={() => setRouteFilter(null)} sx={{ color: md3.secondary }} variant="outlined" />}
            {minObs > 1 && <Chip label={`obs ≥ ${minObs}`} size="small" onDelete={() => setMinObs(1)} sx={{ color: md3.tertiary }} variant="outlined" />}
            {windowMs > 0 && <Chip label={TIME_WINDOWS.find(w => w.ms === windowMs)?.label} size="small" onDelete={() => setWindowMs(0)} sx={{ color: md3.onSurface }} variant="outlined" />}
          </Box>
        )}

        {/* ── Table ── */}
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {([
                  { col: 'id' as SortCol, label: 'ID', width: 60 },
                  { col: null, label: t('packets.hash'), width: '1fr' },
                  { col: 'payloadType' as SortCol, label: t('common.type'), width: 130 },
                  { col: 'routeType' as SortCol, label: t('common.route'), width: 100 },
                  { col: 'obsCount' as SortCol, label: t('packets.obs'), width: 60 },
                  { col: 'firstSeen' as SortCol, label: t('common.firstSeen'), width: 130 },
                ] as { col: SortCol | null; label: string; width: string | number }[]).map(({ col, label, width }) => (
                  <TableCell key={String(col ?? label)} sx={{ width, cursor: col ? 'pointer' : 'default', userSelect: 'none' }}
                    onClick={() => col && toggleSort(col)}>
                    {label}{col ? sortArrow(col) : ''}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 5, color: md3.onSurfaceVariant }}>
                    {packets.length === 0 ? t('packets.noPackets') : t('packets.noMatch')}
                  </TableCell>
                </TableRow>
              )}
              {filtered.map(p => {
                const dec   = p.decoded
                const color = typeColor(p.payloadType)
                const label = (dec?.name ?? dec?.sender ?? dec?.channel) as string | undefined
                const isSelected = selected?.hash === p.hash
                return (
                  <TableRow key={p.id} selected={isSelected} onClick={() => selectPacket(p)}>
                    <TableCell sx={{ color: md3.outline, fontSize: 11 }}>{p.id}</TableCell>
                    <TableCell>
                      <Box component="span" sx={{ fontFamily: 'monospace', color: md3.primary, fontSize: 12 }}>{p.hash}</Box>
                      {label && <Box component="span" sx={{ ml: 1, color: md3.onSurfaceVariant, fontSize: 11 }}>· {label}</Box>}
                    </TableCell>
                    <TableCell>
                      <Chip label={PAYLOAD_NAMES[p.payloadType] ?? p.payloadType} size="small"
                        sx={{ background: alpha(color, 0.15), color, border: `1px solid ${alpha(color, 0.3)}`, fontSize: 11, height: 22 }} />
                    </TableCell>
                    <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>
                      {ROUTE_NAMES[p.routeType] ?? p.routeType}
                    </TableCell>
                    <TableCell sx={{ color: p.obsCount > 1 ? md3.tertiary : md3.outline, fontWeight: p.obsCount > 1 ? 700 : 400 }}>
                      {p.obsCount}
                    </TableCell>
                    <TableCell sx={{ color: md3.outline, fontSize: 11 }}>
                      {new Date(p.firstSeen).toLocaleTimeString()}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {!loading && packets.length < total && (
            <Box sx={{ textAlign: 'center', py: 2 }}>
              <Button variant="outlined" size="small" onClick={() => load(offsetRef.current)}>{t('packets.loadMore')}</Button>
            </Box>
          )}
        </Box>
      </Box>

      {/* ── Detail panel ── */}
      {selected && (
        <PacketDetailPanel selected={selected} onClose={() => setSelected(null)} />
      )}
    </Box>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) {
  const theme = useTheme()
  const md3   = theme.palette.md3
  return (
    <Box sx={{ display: 'flex', gap: 1, mb: 0.75 }}>
      <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, width: 80, flexShrink: 0 }}>{label}</Typography>
      <Typography variant="caption" sx={{ color: md3.onSurface, fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>{value}</Typography>
    </Box>
  )
}

function rssiColor(v: number | null, errColor: string, outline: string) {
  if (v == null) return outline
  return v >= -70 ? '#22c55e' : v >= -90 ? '#f59e0b' : errColor
}

function snrColor(v: number | null, errColor: string, outline: string) {
  if (v == null) return outline
  return v >= 5 ? '#22c55e' : v >= 0 ? '#f59e0b' : errColor
}

function parseHops(pathJson: string): string[] {
  try { return JSON.parse(pathJson) ?? [] } catch { return [] }
}

function relativeTime(ts: string): string {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  return `${Math.round(diff / 3600)}h ago`
}

// Parse rawHex into color-coded sections: header / path / payload
function parseHexSections(rawHex: string, routeType: number): { section: 'header' | 'transport' | 'path' | 'payload'; byte: string }[] {
  const bytes = (rawHex.match(/.{1,2}/g) ?? [])
  if (bytes.length === 0) return []
  const result: { section: 'header' | 'transport' | 'path' | 'payload'; byte: string }[] = []
  let i = 0
  result.push({ section: 'header', byte: bytes[i++] })
  const isTransport = routeType === 0 || routeType === 3
  if (isTransport) {
    for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'transport', byte: bytes[i++] })
  }
  if (i < bytes.length) {
    const pathByte = parseInt(bytes[i], 16)
    const hashSize = ((pathByte >> 6) & 3) + 1
    const hopCount = pathByte & 0x3F
    result.push({ section: 'path', byte: bytes[i++] })
    const pathEnd = i + hopCount * hashSize
    while (i < pathEnd && i < bytes.length) result.push({ section: 'path', byte: bytes[i++] })
  }
  while (i < bytes.length) result.push({ section: 'payload', byte: bytes[i++] })
  return result
}

function PacketDetailPanel({ selected, onClose }: { selected: PacketDetail; onClose: () => void }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()

  const obs = selected.observations ?? []
  const obsWithHops = obs.map(o => ({ ...o, hops: parseHops(o.pathJson) }))
  const longestObs  = obsWithHops.reduce((best, o) => o.hops.length > best.hops.length ? o : best, obsWithHops[0] ?? { hops: [] })
  const uniqueObservers = new Set(obs.map(o => o.observerId)).size
  const times = obs.map(o => new Date(o.timestamp).getTime()).filter(Boolean)
  const propagationMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
  const hexSections = parseHexSections(selected.rawHex ?? '', selected.routeType)

  const sectionColor: Record<string, string> = {
    header:    md3.primary,
    transport: md3.tertiary,
    path:      '#22c55e',
    payload:   md3.onSurfaceVariant,
  }

  const dec = selected.decoded as Record<string, unknown> | null | undefined

  return (
    <Paper elevation={2} sx={{ width: 460, borderLeft: `1px solid ${md3.outlineVariant}`, overflow: 'auto', flexShrink: 0, background: md3.surfaceContainerLow, borderRadius: 0 }}>
      {/* Header */}
      <Box sx={{ px: 2, py: 1.5, borderBottom: `1px solid ${md3.outlineVariant}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 0.75 }}>
            <Chip label={PAYLOAD_NAMES[selected.payloadType] ?? selected.payloadType} size="small"
              sx={{ background: alpha(md3.primary, 0.15), color: md3.primary, fontWeight: 700, fontSize: 11 }} />
            <Chip label={ROUTE_NAMES[selected.routeType] ?? selected.routeType} size="small"
              sx={{ background: alpha(md3.secondary, 0.15), color: md3.secondary, fontSize: 11 }} />
            <Chip label={`${obs.length} obs`} size="small"
              sx={{ background: alpha(md3.tertiary, 0.15), color: md3.tertiary, fontSize: 11 }} />
            {uniqueObservers > 1 && (
              <Chip label={`${uniqueObservers} observers`} size="small"
                sx={{ background: alpha('#22c55e', 0.15), color: '#22c55e', fontSize: 11 }} />
            )}
          </Box>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: md3.outline, fontSize: 11 }}>
            {selected.hash}
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose} sx={{ color: md3.onSurfaceVariant, ml: 1, flexShrink: 0 }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ p: 2 }}>
        {/* Stats row */}
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, mb: 2 }}>
          {[
            { l: t('common.firstSeen'), v: relativeTime(selected.firstSeen) },
            { l: 'Propagation', v: propagationMs > 0 ? `${(propagationMs / 1000).toFixed(1)}s` : '—' },
            { l: 'Max hops', v: longestObs.hops.length > 0 ? `${longestObs.hops.length}` : '—' },
          ].map(({ l, v }) => (
            <Box key={l} sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, px: 1.25, py: 0.75, textAlign: 'center' }}>
              <Typography variant="caption" sx={{ color: md3.outline, display: 'block', fontSize: 10 }}>{l}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>{v}</Typography>
            </Box>
          ))}
        </Box>

        {/* Longest path */}
        {longestObs.hops.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10 }}>Longest path — {longestObs.hops.length} hops</Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
              {longestObs.hops.map((hop, i) => (
                <Chip key={i} label={hop.toUpperCase()} size="small"
                  sx={{ fontFamily: 'monospace', fontSize: 10, height: 20, background: alpha('#22c55e', 0.1), color: '#22c55e', border: `1px solid ${alpha('#22c55e', 0.3)}` }} />
              ))}
            </Box>
          </Box>
        )}

        {/* Decoded payload */}
        {dec && Object.keys(dec).length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>{t('packets.decoded')}</Typography>
            <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, p: 1.25 }}>
              {Object.entries(dec).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
                <Box key={k} sx={{ display: 'flex', gap: 1, mb: 0.4 }}>
                  <Typography variant="caption" sx={{ color: md3.outline, width: 110, flexShrink: 0, fontSize: 11 }}>{k}</Typography>
                  <Typography variant="caption" sx={{ color: md3.onSurface, fontFamily: typeof v === 'string' && v.length > 20 ? 'monospace' : undefined, wordBreak: 'break-all', fontSize: 11 }}>
                    {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {/* Observations table */}
        {obs.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
              {t('packets.observations')} ({obs.length})
            </Typography>
            <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, overflow: 'hidden' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {['Observer', 'Hops', 'SNR', 'RSSI', 'Time'].map(h => (
                      <TableCell key={h} sx={{ fontSize: 10, py: 0.5, color: md3.outline, background: md3.surfaceContainerHighest }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {obsWithHops.map(o => (
                    <TableRow key={o.id}>
                      <TableCell sx={{ fontSize: 11, maxWidth: 130 }}>
                        <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                          {o.observerName || o.observerId.slice(0, 12)}
                        </Typography>
                        {o.observerIata && <Typography variant="caption" sx={{ color: md3.tertiary, fontSize: 10 }}>{o.observerIata}</Typography>}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: o.hops.length > 0 ? md3.primary : md3.outline }}>
                        {o.hops.length > 0 ? o.hops.length : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: snrColor(o.snr, md3.error, md3.outline) }}>
                        {o.snr != null ? `${o.snr} dB` : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: rssiColor(o.rssi, md3.error, md3.outline) }}>
                        {o.rssi != null ? `${o.rssi}` : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 10, color: md3.outline, whiteSpace: 'nowrap' }}>
                        {relativeTime(o.timestamp)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Box>
        )}

        {/* Colored hex */}
        <Box>
          <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
            {t('packets.rawHex')} ({(selected.rawHex?.length ?? 0) / 2} bytes)
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 0.75 }}>
            {(['header', 'transport', 'path', 'payload'] as const).map(s => (
              hexSections.some(b => b.section === s) && (
                <Box key={s} sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: sectionColor[s] }} />
                  <Typography variant="caption" sx={{ fontSize: 10, color: md3.outline, textTransform: 'capitalize' }}>{s}</Typography>
                </Box>
              )
            ))}
          </Box>
          <Box sx={{ fontFamily: 'monospace', background: md3.surfaceContainerHighest, p: 1.25, borderRadius: 2, lineHeight: 2, wordBreak: 'break-all', overflowWrap: 'anywhere' }}>
            {hexSections.map((b, i) => (
              <Box key={i} component="span"
                sx={{ fontSize: 11, color: sectionColor[b.section], mr: 0.4 }}>
                {b.byte.toUpperCase()}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </Paper>
  )
}
