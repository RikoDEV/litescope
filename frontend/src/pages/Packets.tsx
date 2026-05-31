import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Box from '@mui/material/Box'
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
import PacketDetailPanel from '../components/PacketDetailPanel'

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

          <ToggleButtonGroup exclusive size="small" value={windowMs} onChange={(_, v) => v !== null && setWindowMs(v)} sx={{ ml: 1 }}>
            {TIME_WINDOWS.map(tw => (
              <ToggleButton key={tw.ms} value={tw.ms} sx={{ fontSize: 11, px: 1.5, py: 0.5, color: md3.onSurfaceVariant, borderColor: md3.outlineVariant, '&.Mui-selected': { background: alpha(md3.primary, 0.15), color: md3.primary } }}>
                {tw.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <Box sx={{ flex: 1 }} />

          <TextField
            size="small" placeholder={t('packets.searchPlaceholder')}
            value={search} onChange={e => setSearch(e.target.value)}
            sx={{ width: 240 }}
            slotProps={{ input: { endAdornment: search ? <IconButton size="small" onClick={() => setSearch('')}><CloseIcon sx={{ fontSize: 14 }} /></IconButton> : null } }}
          />

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
                    sx={{ background: active ? alpha(color, 0.2) : 'transparent', color: active ? color : md3.onSurfaceVariant, border: `1px solid ${active ? color : md3.outlineVariant}` }}
                  />
                )
              })}
              {typeFilter.size > 0 && <Chip label={t('common.clear')} size="small" onDelete={() => setTypeFilter(new Set())} sx={{ color: md3.outline }} />}
            </Box>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('common.route')}</Typography>
                {([null, 0, 1, 2, 3] as (number | null)[]).map(rt => (
                  <Chip key={String(rt)} label={rt === null ? t('common.all') : ROUTE_LABELS[rt]} size="small" clickable
                    onClick={() => setRouteFilter(routeFilter === rt ? null : rt)}
                    sx={{ background: routeFilter === rt ? alpha(md3.secondary, 0.2) : 'transparent', color: routeFilter === rt ? md3.secondary : md3.onSurfaceVariant, border: `1px solid ${routeFilter === rt ? md3.secondary : md3.outlineVariant}` }}
                  />
                ))}
              </Box>
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
                  { col: 'id' as SortCol, label: t('packets.id'), width: 60 },
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
