import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import IconButton from '@mui/material/IconButton'
import Divider from '@mui/material/Divider'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import CloseIcon from '@mui/icons-material/Close'
import { api } from '../services/api'
import type { Observer } from '../types'
import { formatDistanceToNow } from 'date-fns'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie } from 'recharts'

const DAYS_OPTIONS = [{ l: '24 h', d: 1 }, { l: '3 d', d: 3 }, { l: '7 d', d: 7 }, { l: '30 d', d: 30 }]
const COLORS = ['#D0BCFF','#EFB8C8','#22c55e','#f59e0b','#14b8a6']

interface Analytics {
  timeline: Array<{ hour: string; label: string; count: number }>
  snr: number[]
  snrSummary: { avg: number; min: number; max: number }
  packetTypes: Record<string, number>
}

export default function Observers() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [observers, setObservers] = useState<Observer[]>([])
  const [selected, setSelected]   = useState<Observer | null>(null)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [days, setDays]           = useState(7)
  const [loadingA, setLoadingA]   = useState(false)

  useEffect(() => { api.observers().then(res => setObservers(res.observers ?? [])) }, [])

  // Auto-select from URL param
  useEffect(() => {
    const id = searchParams.get('id')
    if (!id || !observers.length) return
    const o = observers.find(x => x.id === id)
    if (o) { select(o); setSearchParams({}, { replace: true }) }
  }, [observers]) // eslint-disable-line react-hooks/exhaustive-deps

  const select = async (o: Observer) => {
    if (selected?.id === o.id) { setSelected(null); setAnalytics(null); return }
    setSelected(o); setAnalytics(null); loadA(o.id, days)
  }

  const loadA = async (id: string, d: number) => {
    setLoadingA(true)
    try { setAnalytics(await api.observerAnalytics(id, d)) }
    finally { setLoadingA(false) }
  }

  const changeDays = (d: number) => { setDays(d); if (selected) loadA(selected.id, d) }
  const isActive = (o: Observer) => Date.now() - new Date(o.lastSeen).getTime() < 5 * 60e3

  const snrBuckets  = analytics?.snr?.length ? bucketize(analytics.snr, -25, 15, 10) : []
  const typePie     = analytics?.packetTypes ? Object.entries(analytics.packetTypes).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })) : []
  const labelStep   = days <= 1 ? 4 : days <= 3 ? 12 : 24
  const chartLine   = (analytics?.timeline ?? []).map((b, i) => ({ ...b, displayLabel: i % labelStep === 0 ? b.label : '' }))

  return (
    <Box sx={{ display: 'flex', height: '100%', background: md3.background }}>
      {/* ── List ── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box sx={{ px: 2, py: 1.25, borderBottom: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow, flexShrink: 0 }}>
          <Typography variant="body2" sx={{ color: md3.onSurfaceVariant }}>
            <Box component="span" sx={{ fontWeight: 700, color: md3.onSurface }}>{observers.length}</Box> {t('nav.observers').toLowerCase()} ·{' '}
            <Box component="span" sx={{ color: '#22c55e' }}>{observers.filter(isActive).length}</Box> {t('common.active').toLowerCase()}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {[t('observers.nameId'), 'IATA', t('common.model'), t('common.packets'), t('common.lastSeen')].map(h => <TableCell key={h}>{h}</TableCell>)}
              </TableRow>
            </TableHead>
            <TableBody>
              {observers.map(o => (
                <TableRow key={o.id} selected={selected?.id === o.id} onClick={() => select(o)}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
                      <Box sx={{ width: 7, height: 7, borderRadius: '50%', background: isActive(o) ? '#22c55e' : md3.outline, flexShrink: 0 }} />
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{o.name || '—'}</Typography>
                    </Box>
                    <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', pl: 1.5 }}>{o.id.slice(0, 22)}…</Typography>
                  </TableCell>
                  <TableCell>
                    {o.iata && <Chip label={o.iata} size="small" sx={{ background: alpha(md3.tertiary, 0.15), color: md3.tertiary, fontWeight: 700, fontSize: 12, height: 22 }} />}
                  </TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 12 }}>{o.model || '—'}</TableCell>
                  <TableCell sx={{ color: md3.primary, fontWeight: 700 }}>{o.packetCount.toLocaleString()}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>
                    {formatDistanceToNow(new Date(o.lastSeen), { addSuffix: true })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Box>

      {/* ── Detail ── */}
      {selected && (
        <Paper elevation={2} sx={{ width: 420, borderLeft: `1px solid ${md3.outlineVariant}`, overflow: 'auto', flexShrink: 0, background: md3.surfaceContainerLow, borderRadius: 0 }}>
          {/* Header */}
          <Box sx={{ p: 2, borderBottom: `1px solid ${md3.outlineVariant}` }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{selected.name || t('nav.observers')}</Typography>
                {selected.iata && <Chip label={selected.iata} size="small" sx={{ background: alpha(md3.tertiary, 0.2), color: md3.tertiary, fontWeight: 700 }} />}
              </Box>
              <IconButton size="small" onClick={() => { setSelected(null); setAnalytics(null) }} sx={{ alignSelf: 'flex-start', color: md3.onSurfaceVariant }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>

            {/* Stats grid */}
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mb: 1.5 }}>
              {[
                { l: t('common.status'),   v: isActive(selected) ? `🟢 ${t('common.online')}` : `⚪ ${t('common.stale')}` },
                { l: t('common.packets'),  v: selected.packetCount.toLocaleString() },
                { l: t('common.model'),    v: selected.model || '—' },
                { l: 'Firmware', v: selected.firmware || '—' },
                { l: t('common.battery'),  v: selected.batteryMv ? `${selected.batteryMv} mV` : '—' },
                { l: t('common.uptime'),   v: selected.uptimeSecs ? fmtUptime(selected.uptimeSecs) : '—' },
                { l: t('observers.noise'), v: selected.noiseFloor != null ? `${selected.noiseFloor.toFixed(1)} dBm` : '—' },
                { l: t('observers.first'), v: new Date(selected.firstSeen).toLocaleDateString() },
              ].map(({ l, v }) => (
                <Box key={l} sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, px: 1.25, py: 0.75 }}>
                  <Typography variant="caption" sx={{ color: md3.outline, display: 'block' }}>{l}</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>{v}</Typography>
                </Box>
              ))}
            </Box>

            {/* Day range */}
            <ToggleButtonGroup exclusive value={days} onChange={(_, d) => d && changeDays(d)} size="small">
              {DAYS_OPTIONS.map(o => <ToggleButton key={o.d} value={o.d} sx={{ fontSize: 11, px: 1.5, py: 0.4 }}>{o.l}</ToggleButton>)}
            </ToggleButtonGroup>
          </Box>

          {/* Charts */}
          <Box sx={{ p: 2 }}>
            {loadingA && <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, textAlign: 'center', py: 3 }}>{t('common.loading')}</Typography>}
            {analytics && !loadingA && (
              <>
                {chartLine.length > 0 && (
                  <>
                    <Typography variant="overline" sx={{ color: md3.outline }}>{t('observers.packetsOverTime')}</Typography>
                    <ResponsiveContainer width="100%" height={120} style={{ marginTop: 4 }}>
                      <BarChart data={chartLine} barSize={3}>
                        <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
                        <XAxis dataKey="displayLabel" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} interval={0} />
                        <YAxis tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} />
                        <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ''} />
                        <Bar dataKey="count" fill={md3.primary} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                    <Divider sx={{ my: 1.5 }} />
                  </>
                )}
                {snrBuckets.length > 0 && analytics.snrSummary.avg !== 0 && (
                  <>
                    <Typography variant="overline" sx={{ color: md3.outline }}>{t('observers.snrAvg', { value: analytics.snrSummary.avg.toFixed(1) })}</Typography>
                    <ResponsiveContainer width="100%" height={100} style={{ marginTop: 4 }}>
                      <BarChart data={snrBuckets}>
                        <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
                        <XAxis dataKey="label" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} />
                        <YAxis hide />
                        <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} />
                        <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                          {snrBuckets.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > 6 ? '#22c55e' : parseFloat(b.label) > 0 ? '#f59e0b' : md3.error} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <Divider sx={{ my: 1.5 }} />
                  </>
                )}
                {typePie.length > 0 && (
                  <>
                    <Typography variant="overline" sx={{ color: md3.outline }}>{t('observers.packetTypes')}</Typography>
                    <ResponsiveContainer width="100%" height={150} style={{ marginTop: 4 }}>
                      <PieChart>
                        <Pie data={typePie} dataKey="value" cx="50%" cy="50%" outerRadius={60}
                          label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                          {typePie.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </>
                )}
              </>
            )}
          </Box>
        </Paper>
      )}
    </Box>
  )
}

function bucketize(vals: number[], min: number, max: number, buckets: number) {
  const size = (max - min) / buckets; const counts = Array(buckets).fill(0)
  for (const v of vals) counts[Math.min(buckets - 1, Math.max(0, Math.floor((v - min) / size)))]++
  return counts.map((count, i) => ({ label: `${(min + i * size).toFixed(0)}`, count }))
}

function fmtUptime(secs: number) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3600) / 60)}m`
}
