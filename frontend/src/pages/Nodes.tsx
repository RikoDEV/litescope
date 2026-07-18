import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { IataFlag } from '../utils/flags'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Chip from '@mui/material/Chip'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import CloseIcon from '@mui/icons-material/Close'
import { api } from '../services/api'
import type { Node, NodeOverview, RFStats } from '../types'
import { formatDistanceToNow } from 'date-fns'
import { useDateLocale } from '../hooks/useDateLocale'
import NodeDetailPanel from '../components/NodeDetailPanel'
import { isNodeActive as isActive } from '../utils/nodes'
import { roleColor as roleColorFn } from '../utils/roles'

type SortCol = 'name' | 'role' | 'lastSeen' | 'advertCount'

export default function Nodes() {
  const theme = useTheme()
  const md3   = theme.palette.md3
  const { t } = useTranslation()
  const dateLocale = useDateLocale()

  const LAST_HEARD_OPTIONS = [
    { value: '', label: t('common.anyTime') },
    { value: '1h', label: '1h' },
    { value: '6h', label: '6h' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
  ]

  const ROLE_LABEL: Record<string, string> = {
    repeater: t('nodes.repeaters'), companion: t('nodes.companions'),
    room: t('nodes.rooms'), sensor: t('nodes.sensors'),
  }

  const [searchParams] = useSearchParams()

  const [allNodes, setAllNodes]   = useState<Node[]>([])
  const [counts, setCounts]       = useState<Record<string, number>>({})
  const [iatas, setIATAs]         = useState<string[]>([])
  const [selected, setSelected]   = useState<Node | null>(null)
  const [overview, setOverview]   = useState<NodeOverview | null>(null)
  const [rf, setRF]               = useState<RFStats | null>(null)

  const [search, setSearch]     = useState(() => searchParams.get('search') ?? '')
  const [roleTab, setRoleTab]   = useState('all')
  const [status, setStatus]     = useState('all')
  const [lastHeard, setLastHeard] = useState('')
  const [iata, setIata]         = useState('')
  const [sortCol, setSortCol]   = useState<SortCol>('lastSeen')
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('desc')

  const PAGE = 60
  const [visibleCount, setVisibleCount] = useState(PAGE)
  const sentinelRef = useRef<HTMLTableRowElement>(null)

  useEffect(() => { api.iatas().then(c => setIATAs((c ?? []).sort())) }, [])

  useEffect(() => {
    api.nodes({ iata: iata || undefined, status: status !== 'all' ? status : undefined, lastHeard: lastHeard || undefined })
      .then(res => { setAllNodes(res.nodes ?? []); setCounts(res.counts ?? {}) })
  }, [iata, status, lastHeard])

  const filtered = useMemo(() => {
    let list = allNodes
    if (roleTab !== 'all') list = list.filter(n => n.role === roleTab)
    if (search.trim()) {
      let q = search.trim().toLowerCase()
      if (q.endsWith('*')) {
        q = q.slice(0, -1);
        list = list.filter(n => n.name.toLowerCase().startsWith(q) || n.pubKey.toLowerCase().startsWith(q))
      } else {
        list = list.filter(n => n.name.toLowerCase().includes(q) || n.pubKey.toLowerCase().includes(q))
      }
    }
    return [...list].sort((a, b) => {
      const va = sortCol === 'name' ? a.name.toLowerCase() : sortCol === 'role' ? a.role : sortCol === 'advertCount' ? a.advertCount : new Date(a.lastSeen).getTime()
      const vb = sortCol === 'name' ? b.name.toLowerCase() : sortCol === 'role' ? b.role : sortCol === 'advertCount' ? b.advertCount : new Date(b.lastSeen).getTime()
      return sortDir === 'asc' ? (va < vb ? -1 : 1) : (va > vb ? -1 : 1)
    })
  }, [allNodes, roleTab, search, sortCol, sortDir])

  // Reset window on filter/sort change; expand it if the selected row is beyond the window
  useEffect(() => {
    const selectedIdx = selected ? filtered.findIndex(n => n.pubKey === selected.pubKey) : -1
    setVisibleCount(selectedIdx >= 0 ? Math.max(PAGE, selectedIdx + 1) : PAGE)
  }, [filtered]) // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver: load next page when sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) setVisibleCount(v => v + PAGE)
    }, { threshold: 0 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [filtered]) // re-attach when filtered changes (sentinel may re-mount)

  // Derived value so the effect re-fires whenever the pubkey param changes
  const pubkeyParam = searchParams.get('pubkey')

  // Sync URL → selection: runs when allNodes loads OR when pubkeyParam changes
  useEffect(() => {
    if (!pubkeyParam || !allNodes.length) return
    const n = allNodes.find(x => x.pubKey === pubkeyParam)
    if (n) selectNode(n)
  }, [allNodes, pubkeyParam]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRowRef = useRef<HTMLTableRowElement>(null)

  useEffect(() => {
    if (selected && selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selected?.pubKey])

  const selectNode = async (n: Node) => {
    if (selected?.pubKey === n.pubKey) { setSelected(null); setOverview(null); setRF(null); return }
    setSelected(n); setOverview(null); setRF(null)
    const [ov, rfData] = await Promise.all([api.nodeOverview(n.pubKey), api.nodeRF(n.pubKey)])
    setOverview(ov)
    setRF(rfData)
  }

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const roleColor = (role: string) => roleColorFn(role, md3)

  const sortArrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  return (
    <Box sx={{ display: 'flex', height: '100%', background: md3.background }}>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* ── Top bar ── */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25, borderBottom: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow, flexWrap: 'wrap', flexShrink: 0 }}>
          {(['repeater', 'companion', 'room', 'sensor'] as const).map(role => (
            <Chip key={role} label={`${counts[role] ?? 0} ${ROLE_LABEL[role]}`} size="small" clickable
              onClick={() => setRoleTab(prev => prev === role ? 'all' : role)}
              sx={{
                background: roleTab === role ? alpha(roleColor(role), 0.2) : 'transparent',
                color: roleTab === role ? roleColor(role) : md3.onSurfaceVariant,
                border: `1px solid ${roleTab === role ? roleColor(role) : md3.outlineVariant}`,
                fontWeight: roleTab === role ? 700 : 400,
              }}
            />
          ))}
          <Box sx={{ flex: 1 }} />
          <TextField size="small" placeholder={t('nodes.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} sx={{ width: 220 }} />
          {(roleTab !== 'all' || status !== 'all' || lastHeard || iata || search) && (
            <Button size="small" color="error" startIcon={<CloseIcon />} onClick={() => { setSearch(''); setRoleTab('all'); setStatus('all'); setLastHeard(''); setIata('') }}>
              {t('common.clear')}
            </Button>
          )}
        </Box>

        {/* ── Filter row ── */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 0.75, background: md3.surfaceContainerHighest, borderBottom: `1px solid ${md3.outlineVariant}`, flexWrap: 'wrap', flexShrink: 0 }}>
          {iatas.length > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('common.region')}</Typography>
              <Chip label={t('common.all')} size="small" clickable onClick={() => setIata('')} sx={{ background: !iata ? alpha(md3.secondary, 0.2) : 'transparent', color: !iata ? md3.secondary : md3.outline, border: `1px solid ${!iata ? md3.secondary : md3.outlineVariant}` }} />
              {iatas.map(code => (
                <Chip key={code} label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={code} size={12} />{code}</Box>} size="small" clickable onClick={() => setIata(i => i === code ? '' : code)}
                  sx={{ background: iata === code ? alpha(md3.secondary, 0.2) : 'transparent', color: iata === code ? md3.secondary : md3.outline, border: `1px solid ${iata === code ? md3.secondary : md3.outlineVariant}` }} />
              ))}
              <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            </Box>
          )}

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('common.status')}</Typography>
            {(['all', 'active', 'stale'] as const).map(s => (
              <Chip key={s} label={s === 'all' ? t('common.all') : s === 'active' ? `🟢 ${t('common.active')}` : `⚪ ${t('common.stale')}`} size="small" clickable onClick={() => setStatus(s)}
                sx={{ background: status === s ? alpha(s === 'active' ? '#22c55e' : s === 'stale' ? md3.error : md3.outline, 0.2) : 'transparent', color: status === s ? (s === 'active' ? '#22c55e' : s === 'stale' ? md3.error : md3.onSurface) : md3.outline, border: `1px solid ${status === s ? (s === 'active' ? '#22c55e' : s === 'stale' ? md3.error : md3.outline) : md3.outlineVariant}` }} />
            ))}
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('nodes.lastHeard')}</Typography>
            <Select size="small" value={lastHeard} onChange={e => setLastHeard(e.target.value)} sx={{ minWidth: 120, height: 28, fontSize: 12 }}>
              {LAST_HEARD_OPTIONS.map(o => <MenuItem key={o.value} value={o.value} sx={{ fontSize: 13 }}>{o.label}</MenuItem>)}
            </Select>
          </Box>

          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, ml: 'auto' }}>
            <Box component="span" sx={{ color: md3.onSurface, fontWeight: 700 }}>{filtered.length}</Box> / {allNodes.length}
          </Typography>
        </Box>

        {/* ── Table ── */}
        <Box sx={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {([
                  { col: 'name', label: t('nodes.namePubkey') },
                  { col: 'role', label: t('common.role') },
                  { col: null, label: t('common.location') },
                  { col: 'advertCount', label: t('common.adverts') },
                  { col: 'lastSeen', label: t('common.lastSeen') },
                  { col: null, label: t('common.status') },
                ] as { col: SortCol | null; label: string }[]).map(({ col, label }) => (
                  <TableCell key={String(col ?? label)} sx={{ cursor: col ? 'pointer' : 'default' }} onClick={() => col && toggleSort(col)}>
                    {label}{col ? sortArrow(col) : ''}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 5, color: md3.onSurfaceVariant }}>{t('nodes.noMatch')}</TableCell></TableRow>
              )}
              {filtered.slice(0, visibleCount).map(n => {
                const active = isActive(n)
                const color  = roleColor(n.role)
                return (
                  <TableRow key={n.pubKey} ref={selected?.pubKey === n.pubKey ? selectedRowRef : null} selected={selected?.pubKey === n.pubKey} onClick={() => selectNode(n)}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600, color: md3.onSurface }}>{n.name || '—'}</Typography>
                      <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace' }}>{n.pubKey.slice(0, 20)}…</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={n.role} size="small" sx={{ background: alpha(color, 0.15), color, border: `1px solid ${alpha(color, 0.3)}`, fontSize: 11, height: 22 }} />
                    </TableCell>
                    <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 12 }}>
                      {n.lat != null ? (
                        n.locationApprox ? (
                          <Tooltip title={t('nodes.locationApprox')} arrow placement="top">
                            <span style={{ cursor: 'help' }}>≈ {n.lat.toFixed(2)}, {n.lon?.toFixed(2)}</span>
                          </Tooltip>
                        ) : `${n.lat.toFixed(2)}, ${n.lon?.toFixed(2)}`
                      ) : '—'}
                    </TableCell>
                    <TableCell sx={{ color: md3.primary, fontWeight: 700 }}>{n.advertCount}</TableCell>
                    <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>
                      {formatDistanceToNow(new Date(n.lastSeen), { addSuffix: true, locale: dateLocale })}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ color: active ? '#22c55e' : md3.outline }}>
                        {active ? `🟢 ${t('common.active')}` : `⚪ ${t('common.stale')}`}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )
              })}
              {visibleCount < filtered.length && (
                <TableRow ref={sentinelRef}>
                  <TableCell colSpan={6} sx={{ py: 1.5, textAlign: 'center' }}>
                    <Typography variant="caption" sx={{ color: md3.outline }}>
                      {filtered.length - visibleCount} more…
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Box>

      {/* ── Detail panel ── */}
      {selected && (
        <NodeDetailPanel
          selected={selected}
          overview={overview}
          rf={rf}
          onClose={() => { setSelected(null); setOverview(null); setRF(null) }}
        />
      )}
    </Box>
  )
}
