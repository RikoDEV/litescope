import { useEffect, useState } from 'react'
import { getEnv } from '../env'
import { IataFlag } from '../utils/flags'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Collapse from '@mui/material/Collapse'
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
import Tooltip from '@mui/material/Tooltip'
import Divider from '@mui/material/Divider'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import CloseIcon from '@mui/icons-material/Close'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CheckIcon from '@mui/icons-material/Check'
import WifiIcon from '@mui/icons-material/Wifi'
import { api } from '../services/api'
import type { Observer } from '../types'
import { bucketize } from '../utils/stats'
import { useDateLocale } from '../hooks/useDateLocale'
import { formatDistanceToNow } from 'date-fns'
import { BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'

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
  const dateLocale = useDateLocale()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [observers, setObservers] = useState<Observer[]>([])
  const [selected, setSelected]   = useState<Observer | null>(null)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [days, setDays]           = useState(7)
  const [loadingA, setLoadingA]   = useState(false)
  const observerIdParam = searchParams.get('id')

  useEffect(() => { api.observers().then(res => setObservers(res.observers ?? [])) }, [])

  const loadA = async (id: string, d: number) => {
    setLoadingA(true)
    try { setAnalytics(await api.observerAnalytics(id, d)) }
    finally { setLoadingA(false) }
  }

  const openObserver = (o: Observer) => {
    setSelected(o); setAnalytics(null); loadA(o.id, days)
  }

  const select = async (o: Observer) => {
    if (selected?.id === o.id) { setSelected(null); setAnalytics(null); return }
    openObserver(o)
  }

  // Auto-select from URL param. This must open the panel, not toggle it.
  useEffect(() => {
    if (!observerIdParam || !observers.length) return
    const o = observers.find(x => x.id === observerIdParam)
    if (o) { openObserver(o); setSearchParams({}, { replace: true }) }
  }, [observerIdParam, observers]) // eslint-disable-line react-hooks/exhaustive-deps

  const changeDays = (d: number) => { setDays(d); if (selected) loadA(selected.id, d) }
  const isActive = (o: Observer) => Date.now() - new Date(o.lastSeen).getTime() < 5 * 60e3

  const snrBuckets  = analytics?.snr?.length ? bucketize(analytics.snr, -25, 15, 10) : []
  const typePie     = analytics?.packetTypes ? Object.entries(analytics.packetTypes).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })) : []
  const labelStep   = days <= 1 ? 4 : days <= 3 ? 12 : 24
  const chartLine   = analytics?.timeline ?? []

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
        <ObserverSetupCard />
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
                    {o.iata && <Chip label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={o.iata} size={12} />{o.iata}</Box>} size="small" sx={{ background: alpha(md3.tertiary, 0.15), color: md3.tertiary, fontWeight: 700, fontSize: 12, height: 22 }} />}
                  </TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 12 }}>{o.model || '—'}</TableCell>
                  <TableCell sx={{ color: md3.primary, fontWeight: 700 }}>{o.packetCount.toLocaleString()}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>
                    {formatDistanceToNow(new Date(o.lastSeen), { addSuffix: true, locale: dateLocale })}
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
                <Typography variant="subtitle1" onClick={() => navigate(`/observers?id=${encodeURIComponent(selected.id)}`)}
                  sx={{ fontWeight: 700, cursor: 'pointer', '&:hover': { color: md3.primary, textDecoration: 'underline' } }}>
                  {selected.name || t('nav.observers')}
                </Typography>
                {selected.iata && <Chip label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={selected.iata} size={13} />{selected.iata}</Box>} size="small" sx={{ background: alpha(md3.tertiary, 0.2), color: md3.tertiary, fontWeight: 700 }} />}
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
                { l: t('observers.firmware'), v: selected.firmware || '—' },
                { l: t('common.battery'),  v: selected.batteryMv ? `${selected.batteryMv} mV` : '—' },
                { l: t('common.uptime'),   v: selected.uptimeSecs ? fmtUptime(selected.uptimeSecs) : '—' },
                { l: t('observers.noise'), v: selected.noiseFloor != null ? `${selected.noiseFloor.toFixed(1)} dBm` : '—' },
                { l: t('common.firstSeen'), v: new Date(selected.firstSeen).toLocaleDateString(dateLocale.code) },
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
                      <BarChart data={chartLine} barSize={3} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
                        <XAxis dataKey="label" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} interval={labelStep - 1} />
                        <YAxis width={28} tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} />
                        <RTooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} />
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
                        <RTooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} />
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
                    <ResponsiveContainer width="100%" height={typePie.length * 22 + 8} style={{ marginTop: 4 }}>
                      <BarChart data={typePie} layout="vertical" barSize={10} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" width={72} interval={0} tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} tickLine={false} axisLine={false} />
                        <RTooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} cursor={{ fill: 'transparent' }} />
                        <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                          {typePie.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length] ?? COLORS[0]!} />)}
                        </Bar>
                      </BarChart>
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

// ── ObserverSetupCard ──────────────────────────────────────────────────────────
const MQTT_HOST     = getEnv('VITE_MQTT_HOST')     || window.location.hostname
const MQTT_USERNAME = getEnv('VITE_MQTT_USERNAME')
const MQTT_PASSWORD = getEnv('VITE_MQTT_PASSWORD')

function CopyField({ label, value }: { label: string; value: string }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    })
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Typography variant="caption" sx={{ color: md3.outline, width: 80, flexShrink: 0 }}>{label}</Typography>
      <Box sx={{
        flex: 1, display: 'flex', alignItems: 'center', gap: 0.75,
        px: 1.25, py: 0.4, borderRadius: 1.5,
        background: alpha(md3.surfaceContainerHighest, 0.8),
        border: `1px solid ${alpha(md3.outlineVariant, 0.5)}`,
        fontFamily: 'monospace', fontSize: 12, color: md3.onSurface, minWidth: 0,
      }}>
        <Box sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</Box>
        <Tooltip title={copied ? 'Copied!' : 'Copy'}>
          <IconButton size="small" onClick={copy} sx={{ p: 0.25, color: copied ? '#22c55e' : md3.outline, flexShrink: 0 }}>
            {copied ? <CheckIcon sx={{ fontSize: 13 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  )
}

function ObserverSetupCard() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const steps = [t('observers.step1'), t('observers.step2'), t('observers.step3'), t('observers.step4')]

  return (
    <Card sx={{ borderRadius: 0, borderBottom: `1px solid ${md3.outlineVariant}`, flexShrink: 0 }} elevation={0}>
      <Box
        onClick={() => setOpen(v => !v)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1.5,
          px: 2, py: 1.25, cursor: 'pointer',
          background: md3.surfaceContainerLow,
          '&:hover': { background: alpha(md3.primary, 0.04) },
        }}
      >
        <WifiIcon sx={{ fontSize: 16, color: md3.primary, flexShrink: 0 }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{t('observers.connectObserver')}</Typography>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>
            {t('observers.connectObserverSub')}
          </Typography>
        </Box>
        <ExpandMoreIcon sx={{
          color: md3.outline, fontSize: 18, flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
        }} />
      </Box>

      <Collapse in={open}>
        <CardContent sx={{ background: md3.surfaceContainerLowest, pt: 2 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3 }}>
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 1 }}>{t('observers.setupSteps')}</Typography>
              {steps.map((s, i) => (
                <Box key={i} sx={{ display: 'flex', gap: 1.25, mb: 1.25 }}>
                  <Box sx={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0, mt: 0.15,
                    background: alpha(md3.primary, 0.15),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Typography sx={{ fontSize: 10, fontWeight: 700, color: md3.primary, lineHeight: 1 }}>{i + 1}</Typography>
                  </Box>
                  <Typography variant="body2" sx={{ color: md3.onSurface, lineHeight: 1.5 }}>{s}</Typography>
                </Box>
              ))}
            </Box>
            <Box>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 1 }}>{t('observers.mqttDetails')}</Typography>
              <CopyField label={t('observers.server')}   value={MQTT_HOST} />
              <CopyField label={t('observers.port')}     value="1883" />
              <CopyField label={t('observers.username')} value={MQTT_USERNAME || 'litescope'} />
              <CopyField label={t('observers.password')} value={MQTT_PASSWORD || '—'} />
              <CopyField label={t('observers.topic')}    value="meshcore/<region>/<observer-id>" />
            </Box>
          </Box>
          <Box sx={{
            mt: 2, px: 1.5, py: 1, borderRadius: 1.5, display: 'flex', gap: 1,
            background: alpha(md3.primary, 0.06),
            border: `1px solid ${alpha(md3.primary, 0.2)}`,
          }}>
            <InfoOutlinedIcon sx={{ fontSize: 15, color: md3.primary, flexShrink: 0, mt: 0.2 }} />
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, lineHeight: 1.55 }}>
              {t('observers.iataNote')}
            </Typography>
          </Box>
        </CardContent>
      </Collapse>
    </Card>
  )
}

function fmtUptime(secs: number) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3600) / 60)}m`
}
