import { useEffect, useMemo, useState } from 'react'
import type { ComponentProps } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Box from '@mui/material/Box'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Chip from '@mui/material/Chip'
import Skeleton from '@mui/material/Skeleton'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { api } from '../services/api'
import type { AnalyticsParams } from '../services/api'
import type { Node, Observer, OverviewStats } from '../types'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ScatterChart, Scatter, CartesianGrid,
  AreaChart, Area, ReferenceLine, LineChart, Line,
} from 'recharts'
import AssessmentIcon from '@mui/icons-material/Assessment'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt'
import RouterIcon from '@mui/icons-material/Router'
import WifiIcon from '@mui/icons-material/Wifi'
import ForumIcon from '@mui/icons-material/Forum'
import TagIcon from '@mui/icons-material/Tag'
import PieChartIcon from '@mui/icons-material/PieChart'
import BarChartIcon from '@mui/icons-material/BarChart'
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot'
import LeaderboardIcon from '@mui/icons-material/Leaderboard'
import DonutLargeIcon from '@mui/icons-material/DonutLarge'
import TimelineIcon from '@mui/icons-material/Timeline'
import GroupWorkIcon from '@mui/icons-material/GroupWork'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import Link from '@mui/material/Link'
import type { SvgIconComponent } from '@mui/icons-material'
import { IataFlag } from '../utils/flags'
import { bucketize } from '../utils/stats'
import HashMatrix from '../components/HashMatrix'
import RegionFilter from '../components/RegionFilter'
import { selectedCountries } from '../utils/regions'
import { roleColor as roleColorFn } from '../utils/roles'

/** Props every analytics tab receives: the active filter + a string key to use in effect deps. */
interface TabProps { params: AnalyticsParams; filterKey: string }

const WINDOWS: { h: number; l: string }[] = [
  { h: 24, l: '24h' }, { h: 72, l: '3d' }, { h: 168, l: '7d' },
]

type TabId = 'overview' | 'activity' | 'rf' | 'nodes' | 'observers' | 'channels' | 'hashes' | 'scope' | 'distance'

const TABS: { id: TabId; Icon: SvgIconComponent; tk: string }[] = [
  { id: 'overview',  Icon: AssessmentIcon,       tk: 'analytics.overview' },
  { id: 'activity',  Icon: ShowChartIcon,         tk: 'analytics.activity' },
  { id: 'rf',        Icon: SignalCellularAltIcon, tk: 'analytics.rfSignal' },
  { id: 'nodes',     Icon: RouterIcon,            tk: 'analytics.nodes' },
  { id: 'observers', Icon: WifiIcon,              tk: 'analytics.observers' },
  { id: 'channels',  Icon: ForumIcon,             tk: 'analytics.channels' },
  { id: 'hashes',    Icon: TagIcon,               tk: 'analytics.hashes' },
  { id: 'scope',     Icon: ScatterPlotIcon,       tk: 'analytics.scope' },
  { id: 'distance',  Icon: AccountTreeIcon,       tk: 'analytics.distance' },
]

const PALETTE = ['#D0BCFF','#EFB8C8','#22c55e','#f59e0b','#14b8a6','#a855f7']

export default function Analytics() {
  const theme = useTheme()
  const md3   = theme.palette.md3
  const { t } = useTranslation()
  const { tab: tabParam } = useParams<{ tab?: string }>()
  const navigate = useNavigate()
  const tab = (TABS.some(t => t.id === tabParam) ? tabParam : 'overview') as TabId

  useEffect(() => {
    if (tabParam === 'overview') navigate('/analytics', { replace: true })
  }, [tabParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Global filter (region + time window), applied to every tab ──
  const [iatas, setIatas] = useState<string[]>([])
  const [regionFilter, setRegionFilter] = useState<Set<string>>(new Set())
  const [regionLock, setRegionLock] = useState(false)
  const [windowHours, setWindowHours] = useState(24) // default 24h

  useEffect(() => { api.iatas().then(c => setIatas((c ?? []).sort())).catch(() => {}) }, [])

  const params: AnalyticsParams = useMemo(() => {
    const countries = selectedCountries(regionFilter)
    return {
      hours: windowHours,
      regions: regionFilter.size ? [...regionFilter] : undefined,
      countries: countries.length ? countries : undefined,
      lock: regionLock || undefined,
    }
  }, [windowHours, regionFilter, regionLock])
  const filterKey = `${windowHours}|${[...regionFilter].sort().join(',')}|${regionLock ? 1 : 0}`
  const tabProps: TabProps = { params, filterKey }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', background: md3.background }}>
      {/* ── Global filter bar ── */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, px: 2, py: 1, background: md3.surfaceContainerHighest, borderBottom: `1px solid ${md3.outlineVariant}`, flexShrink: 0 }}>
        {iatas.length > 0 && (
          <RegionFilter iatas={iatas} value={regionFilter} onChange={setRegionFilter} lock={regionLock} onLockChange={setRegionLock} />
        )}
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('analytics.timeWindow')}</Typography>
          <ToggleButtonGroup exclusive size="small" value={windowHours} onChange={(_, v) => v !== null && setWindowHours(v)}>
            {WINDOWS.map(w => (
              <ToggleButton key={w.h} value={w.h} sx={{ fontSize: 11, px: 1.25, py: 0.4, color: md3.onSurfaceVariant, borderColor: md3.outlineVariant, '&.Mui-selected': { background: alpha(md3.primary, 0.15), color: md3.primary } }}>
                {w.l}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      </Box>

      <Tabs value={tab} onChange={(_, v) => navigate(v === 'overview' ? '/analytics' : `/analytics/${v}`, { replace: true })} variant="scrollable" scrollButtons="auto"
        sx={{ px: 2, background: md3.surfaceContainerLow, flexShrink: 0 }}>
        {TABS.map(({ id, Icon, tk }) => (
          <Tab key={id} value={id} iconPosition="start" icon={<Icon sx={{ fontSize: 18 }} />} label={t(tk as Parameters<typeof t>[0])} sx={{ minHeight: 48 }} />
        ))}
      </Tabs>
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {tab === 'overview'  && <OverviewTab {...tabProps} />}
        {tab === 'activity'  && <ActivityTab {...tabProps} />}
        {tab === 'rf'        && <RFTab {...tabProps} />}
        {tab === 'nodes'     && <NodesTab {...tabProps} />}
        {tab === 'observers' && <ObserversTab {...tabProps} />}
        {tab === 'channels'  && <ChannelsTab {...tabProps} />}
        {tab === 'hashes'    && <HashesTab {...tabProps} />}
        {tab === 'scope'     && <ScopeTab {...tabProps} />}
        {tab === 'distance'  && <DistanceTab {...tabProps} />}
      </Box>
    </Box>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────
function OverviewTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [stats, setStats] = useState<OverviewStats | null>(null)
  const [byType, setByType] = useState<Record<string, number>>({})
  const [rf, setRF] = useState<{ snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number }; totalObservations: number } | null>(null)

  useEffect(() => {
    api.overview(params).then(setStats)
    api.packetsByType(params).then(d => setByType(d ?? {}))
    api.analyticsRF(params).then(d => setRF({ snrSummary: d.snrSummary, rssiSummary: d.rssiSummary, totalObservations: d.totalObservations }))
  }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!stats) return <TabLoading />

  const typeData = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))
  const typeTotal = typeData.reduce((s, d) => s + d.value, 0)
  const typeShareData = typeData.map(d => ({ name: d.name, pct: typeTotal > 0 ? +((d.value / typeTotal) * 100).toFixed(1) : 0 }))

  const statCards = [
    { label: t('home.totalPackets'), value: stats?.totalPackets.toLocaleString() ?? '—',          color: md3.primary },
    { label: t('home.nodes'),        value: stats?.totalNodes.toLocaleString() ?? '—',            color: md3.tertiary },
    { label: t('home.observers'),    value: stats?.totalObservers.toLocaleString() ?? '—',        color: '#22c55e' },
    { label: t('home.observations'), value: rf?.totalObservations.toLocaleString() ?? '—',        color: '#f59e0b' },
    { label: t('home.avgSnr'),       value: rf ? `${rf.snrSummary.avg.toFixed(1)} dB` : '—',     color: '#14b8a6', sub: rf ? `${rf.snrSummary.min.toFixed(0)} → ${rf.snrSummary.max.toFixed(0)}` : undefined },
    { label: t('home.avgRssi'),      value: rf ? `${rf.rssiSummary.avg.toFixed(0)} dBm` : '—',   color: md3.error,  sub: rf ? `${rf.rssiSummary.min.toFixed(0)} → ${rf.rssiSummary.max.toFixed(0)}` : undefined },
  ]

  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2, mb: 3 }}>
        {statCards.map(c => (
          <Card key={c.label} sx={{ border: `1px solid ${alpha(c.color, 0.3)}` }}>
            <CardContent sx={{ p: '16px !important' }}>
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.5 }}>{c.label}</Typography>
              <Typography variant="h5" sx={{ color: c.color, fontWeight: 700, fontSize: 24 }}>{c.value}</Typography>
              {c.sub && <Typography variant="caption" sx={{ color: md3.outline }}>{c.sub}</Typography>}
            </CardContent>
          </Card>
        ))}
      </Box>

      {typeData.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
          <ChartCard title={t('analytics.packetTypeDistribution')} Icon={BarChartIcon}>
            <ResponsiveContainer width="100%" height={typeData.length * 22 + 16}>
              <BarChart data={typeData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} />
                <XAxis type="number" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
                <YAxis type="category" dataKey="name" width={90} interval={0} tick={{ fontSize: 11, fill: md3.onSurface }} />
                <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
                <Bar dataKey="value" fill={md3.primary} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title={t('analytics.payloadTypeShare')} Icon={BarChartIcon}>
            <ResponsiveContainer width="100%" height={typeShareData.length * 22 + 16}>
              <BarChart data={typeShareData} layout="vertical" margin={{ top: 4, right: 36, left: 0, bottom: 4 }}>
                <XAxis type="number" unit="%" domain={[0, 100]} tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} tickLine={false} tickCount={5} />
                <YAxis type="category" dataKey="name" width={72} interval={0} tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                  formatter={(v) => [`${v}%`, t('analytics.share')]} />
                <Bar dataKey="pct" radius={[0, 3, 3, 0]} label={{ position: 'right', fontSize: 10, fill: md3.onSurfaceVariant, formatter: (v: unknown) => Number(v) > 0 ? `${v}%` : '' }}>
                  {typeShareData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Box>
      )}
    </Box>
  )
}

// ── Activity ──────────────────────────────────────────────────────────────────
function ActivityTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const hours = params.hours ?? 24 // Activity always needs a finite range; default 24h when "All"
  const [data, setData]   = useState<{ buckets: Array<{ hour: string; label: string; count: number; activeNodes: number; avgFanout: number; payloads: Record<string, number> }>; payloadTypes: string[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { setLoading(true); api.analyticsActivity(hours, params).then(d => setData(d ?? { buckets: [], payloadTypes: [] })).finally(() => setLoading(false)) }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const buckets = data?.buckets ?? []
  const payloadTypes = data?.payloadTypes ?? []
  const peak  = buckets.reduce((m, b) => b.count > m ? b.count : m, 0)
  const total = buckets.reduce((s, b) => s + b.count, 0)
  const avg   = buckets.length > 0 ? total / buckets.length : 0
  const step  = hours <= 24 ? 4 : hours <= 72 ? 12 : 24
  const chartData = buckets.map((b, i) => ({ ...b, displayLabel: i % step === 0 ? b.label : '', ...b.payloads }))

  if (loading && buckets.length === 0) return <TabLoading />

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        {[
          { label: t('home.total'), value: total.toLocaleString(), color: md3.primary },
          { label: t('analytics.peakHour'), value: peak.toLocaleString(), color: md3.tertiary },
          { label: t('analytics.avgHour'), value: avg.toFixed(1), color: md3.onSurfaceVariant },
        ].map(p => (
          <Box key={p.label} sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(p.color, 0.1), border: `1px solid ${alpha(p.color, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{p.label}  </Typography>
            <Typography variant="body2" sx={{ color: p.color, fontWeight: 700, display: 'inline' }}>{p.value}</Typography>
          </Box>
        ))}
      </Box>

      <ChartCard title={t('analytics.packetsPerHourWindow', { hours })} Icon={ShowChartIcon} sx={{ mb: 2 }}>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="actGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={md3.primary} stopOpacity={0.35} />
                <stop offset="95%" stopColor={md3.primary} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
            <XAxis dataKey="displayLabel" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={0} />
            <YAxis tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
            <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ''} />
            <ReferenceLine y={avg} stroke={alpha('#f59e0b', 0.6)} strokeDasharray="4 4" />
            <Area type="monotone" dataKey="count" stroke={md3.primary} fill="url(#actGrad)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <ChartCard title={t('analytics.nodeFanoutActivity')} Icon={TimelineIcon}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="displayLabel" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={0} />
              <YAxis yAxisId="nodes" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis yAxisId="fanout" orientation="right" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ''} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="nodes" type="monotone" dataKey="activeNodes" name={t('analytics.uniqueActiveNodes')} stroke="#14b8a6" strokeWidth={2} dot={false} />
              <Line yAxisId="fanout" type="monotone" dataKey="avgFanout" name={t('analytics.avgObservationFanout')} stroke="#ec4899" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('analytics.payloadMixOverTime')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="displayLabel" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={0} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ''} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {payloadTypes.map((pt, i) => (
                <Bar key={pt} dataKey={pt} stackId="payloads" fill={PALETTE[i % PALETTE.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>
    </Box>
  )
}

// ── RF / Signal ───────────────────────────────────────────────────────────────
function RFTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [rf, setRF] = useState<{ rssi: number[]; snr: number[]; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number }; totalObservations: number } | null>(null)
  const [snrByType, setSnrByType] = useState<Record<string, { avg: number; count: number }>>({})

  useEffect(() => {
    api.analyticsRF(params).then(setRF)
    api.analyticsSnrByType(params).then(d => setSnrByType(d ?? {}))
  }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!rf) return <TabLoading />
  const snr  = rf.snr  ?? []
  const rssi = rf.rssi ?? []
  if (rf.totalObservations === 0 || (snr.length === 0 && rssi.length === 0)) return <Typography sx={{ color: md3.onSurfaceVariant, p: 4 }}>{t('analytics.noRf')}</Typography>

  const snrB  = bucketize(snr,  -25, 15, 16)
  const rssiB = bucketize(rssi, -125, -30, 19)
  const step  = Math.max(1, Math.floor(snr.length / 400))
  const scatter = snr.filter((_, i) => i % step === 0).map((s, i) => ({ snr: s, rssi: rssi[i * step] ?? 0 }))

  const snrTypeData = Object.entries(snrByType)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, v]) => ({ name, avg: +v.avg.toFixed(2), count: v.count }))

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        {[
          { l: t('home.observations'), v: rf.totalObservations.toLocaleString(), c: md3.primary },
          { l: t('home.avgSnr'), v: `${rf.snrSummary.avg.toFixed(1)} dB`, c: '#22c55e' },
          { l: 'Min SNR', v: `${rf.snrSummary.min.toFixed(1)} dB`, c: md3.error },
          { l: t('home.avgRssi'), v: `${rf.rssiSummary.avg.toFixed(0)} dBm`, c: md3.tertiary },
          { l: 'Min RSSI', v: `${rf.rssiSummary.min.toFixed(0)} dBm`, c: md3.error },
        ].map(p => (
          <Box key={p.l} sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{p.l}{'  '}</Typography>
            <Typography variant="body2" sx={{ color: p.c, fontWeight: 700, display: 'inline' }}>{p.v}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mb: 2 }}>
        <ChartCard title={t('analytics.snrDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={snrB} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={0} />
              <YAxis width={28} tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {snrB.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > 6 ? '#22c55e' : parseFloat(b.label) > 0 ? '#f59e0b' : md3.error} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title={t('analytics.rssiDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rssiB} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={0} />
              <YAxis width={28} tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {rssiB.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > -80 ? '#22c55e' : parseFloat(b.label) > -100 ? '#f59e0b' : md3.error} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      {snrTypeData.length > 0 && (
        <ChartCard title={t('analytics.snrByType')} Icon={SignalCellularAltIcon} sx={{ mb: 2 }}>
          <ResponsiveContainer width="100%" height={Math.max(160, snrTypeData.length * 32)}>
            <BarChart data={snrTypeData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis type="number" unit=" dB" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} domain={['auto', 'auto']} />
              <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11, fill: md3.onSurface }} />
              <ReferenceLine x={0} stroke={alpha(md3.error, 0.5)} strokeDasharray="4 4" />
              <ReferenceLine x={6} stroke={alpha('#22c55e', 0.4)} strokeDasharray="4 4" />
              <Tooltip
                contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                formatter={(v: unknown, _: unknown, entry: { payload?: { count: number } }) => [`${(v as number).toFixed(2)} dB (${entry.payload?.count ?? 0} obs)`, 'Avg SNR']}
              />
              <Bar dataKey="avg" radius={[0, 4, 4, 0]}>
                {snrTypeData.map((d, i) => <Cell key={i} fill={d.avg > 6 ? '#22c55e' : d.avg > 0 ? '#f59e0b' : md3.error} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {scatter.length > 0 && (
        <ChartCard title={t('analytics.snrVsRssi', { count: scatter.length })} Icon={ScatterPlotIcon}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 1 }}>
            <Box component="span" sx={{ color: '#22c55e' }}>● SNR &gt; 6</Box>{'  '}
            <Box component="span" sx={{ color: '#f59e0b' }}>● 0–6</Box>{'  '}
            <Box component="span" sx={{ color: md3.error }}>● &lt; 0</Box>
          </Typography>
          <ResponsiveContainer width="100%" height={260}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="rssi" name="RSSI" unit=" dBm" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis dataKey="snr" name="SNR" unit=" dB" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <ReferenceLine y={0} stroke={alpha(md3.error, 0.4)} strokeDasharray="4 4" />
              <ReferenceLine y={6} stroke={alpha('#22c55e', 0.4)} strokeDasharray="4 4" />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Scatter data={scatter} shape={({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { snr: number } }) => {
                const color = (payload?.snr ?? 0) > 6 ? '#22c55e' : (payload?.snr ?? 0) > 0 ? '#f59e0b' : md3.error
                return <circle cx={cx} cy={cy} r={3} fill={color} fillOpacity={0.65} />
              }} />
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </Box>
  )
}

// ── Nodes ─────────────────────────────────────────────────────────────────────
function NodesTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [topSort, setTopSort] = useState<'adverts' | 'retransmits'>('adverts')
  useEffect(() => { api.analyticsNodesTop(25, topSort, params).then(d => setNodes(d ?? [])) }, [filterKey, topSort]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!nodes) return <TabLoading />

  const roleColor = (r: string) => roleColorFn(r, md3)
  const metric = (n: Node) => topSort === 'retransmits' ? (n.retransmitCount ?? 0) : n.advertCount
  const metricLabel = topSort === 'retransmits' ? t('common.retransmits') : t('common.adverts')
  const roleCounts: Record<string, number> = {}
  for (const n of nodes) roleCounts[n.role] = (roleCounts[n.role] ?? 0) + 1
  const rolePie = Object.entries(roleCounts).map(([name, value]) => ({ name, value }))

  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 260px' }, gap: 2, mb: 2 }}>
        <ChartCard title={t('analytics.topNodes')} Icon={BarChartIcon}>
          <ToggleButtonGroup size="small" exclusive value={topSort} onChange={(_, v) => v && setTopSort(v)}
            sx={{ mb: 1, '& .MuiToggleButton-root': { py: 0.25, px: 1.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="adverts">{t('common.adverts')}</ToggleButton>
            <ToggleButton value="retransmits">{t('common.retransmits')}</ToggleButton>
          </ToggleButtonGroup>
          <ResponsiveContainer width="100%" height={Math.max(180, nodes.length * 26)}>
            <BarChart data={nodes.map(n => ({ name: n.name || n.pubKey.slice(0, 8), count: metric(n), role: n.role }))} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis type="number" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: md3.onSurface }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {nodes.map((n, i) => <Cell key={i} fill={roleColor(n.role)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title={t('analytics.roleDistribution')} Icon={DonutLargeIcon}>
          <ResponsiveContainer width="100%" height={rolePie.length * 28 + 16}>
            <BarChart data={rolePie} layout="vertical" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} tickLine={false} />
              <YAxis type="category" dataKey="name" width={80} interval={0} tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {rolePie.map((e, i) => <Cell key={i} fill={roleColor(e.name)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      <ChartCard title={t('analytics.leaderboard')} Icon={LeaderboardIcon}>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 560 }}>
          <TableHead>
            <TableRow>
              {['#', t('common.name'), t('common.role'), metricLabel, t('common.lastSeen'), t('common.location')].map(h => <TableCell key={h}>{h}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {nodes.map((n, i) => (
              <TableRow key={n.pubKey}>
                <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{n.name || n.pubKey.slice(0, 12) + '…'}</TableCell>
                <TableCell><Chip label={n.role} size="small" sx={{ background: alpha(roleColor(n.role), 0.15), color: roleColor(n.role), fontSize: 11, height: 20 }} /></TableCell>
                <TableCell sx={{ color: md3.primary, fontWeight: 700 }}>{metric(n).toLocaleString()}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{new Date(n.lastSeen).toLocaleDateString()}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{n.lat != null ? `${n.lat.toFixed(2)}, ${n.lon?.toFixed(2)}` : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </Box>
      </ChartCard>
    </Box>
  )
}

// ── Observers ─────────────────────────────────────────────────────────────────
function ObserversTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [observers, setObservers] = useState<Observer[] | null>(null)
  useEffect(() => { api.analyticsObserversTop(20, params).then(d => setObservers(d ?? [])) }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!observers) return <TabLoading />

  return (
    <Box>
      <ChartCard title={t('analytics.topObserversByPacket')} Icon={BarChartIcon}>
        <ResponsiveContainer width="100%" height={Math.max(160, observers.length * 30)}>
          <BarChart data={observers.map(o => ({ name: o.name || o.id.slice(0, 12), count: o.packetCount, iata: o.iata }))} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
            <XAxis type="number" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
            <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: md3.onSurface }} />
            <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
            <Bar dataKey="count" fill={md3.tertiary} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title={t('analytics.observerRoster')} Icon={LeaderboardIcon} sx={{ mt: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 680 }}>
          <TableHead>
            <TableRow>
              {['#', t('common.name'), 'IATA', t('common.packets'), t('common.model'), t('common.battery'), t('common.uptime'), t('common.lastSeen')].map(h => <TableCell key={h}>{h}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {observers.map((o, i) => {
              const active = Date.now() - new Date(o.lastSeen).getTime() < 5 * 60e3
              return (
                <TableRow key={o.id}>
                  <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: active ? '#22c55e' : md3.outline, display: 'inline-block', mr: 1 }} />
                    {o.name || o.id.slice(0, 14) + '…'}
                  </TableCell>
                  <TableCell sx={{ color: md3.tertiary, fontWeight: 700 }}>{o.iata ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={o.iata} size={13} />{o.iata}</Box> : '—'}</TableCell>
                  <TableCell sx={{ color: md3.primary, fontWeight: 700 }}>{o.packetCount.toLocaleString()}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{o.model || '—'}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{o.batteryMv ? `${o.batteryMv} mV` : '—'}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{o.uptimeSecs ? fmtUptime(o.uptimeSecs) : '—'}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{new Date(o.lastSeen).toLocaleDateString()}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        </Box>
      </ChartCard>
    </Box>
  )
}

// ── Channels ──────────────────────────────────────────────────────────────────
function ChannelsTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [channels, setChannels] = useState<Array<{ hash: string; name: string; messageCount: number }> | null>(null)
  const [analytics, setAnalytics] = useState<{
    activityChannels: string[]
    activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
    topSenders: Array<{ sender: string; messageCount: number; channels: number }>
  } | null>(null)
  useEffect(() => {
    api.channelsFiltered(params).then(d => setChannels([...(d ?? [])].filter(c => c.name && c.name !== c.hash).sort((a, b) => b.messageCount - a.messageCount)))
    api.analyticsChannels(params).then(setAnalytics)
  }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!channels) return <TabLoading />

  const chColor = (name: string, i: number) => name === 'Other' ? md3.outline : PALETTE[i % PALETTE.length]
  const actChart = (analytics?.activity ?? []).map((h, i) => ({ label: h.label, displayLabel: i % 4 === 0 ? h.label : '', ...h.counts }))

  const total = channels.reduce((s, c) => s + c.messageCount, 0)

  if (channels.length === 0) return (
    <Typography sx={{ color: md3.onSurfaceVariant, p: 4 }}>{t('analytics.noChannelData')}</Typography>
  )

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        {[
          { l: t('analytics.totalChannels'), v: channels.length.toString(), c: md3.primary },
          { l: t('analytics.totalMessages'), v: total.toLocaleString(), c: '#ec4899' },
          { l: t('analytics.mostActive'), v: channels[0]?.name || channels[0]?.hash.slice(0, 8), c: md3.tertiary },
        ].map(p => (
          <Box key={p.l} sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{p.l}{'  '}</Typography>
            <Typography variant="body2" sx={{ color: p.c, fontWeight: 700, display: 'inline' }}>{p.v}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <ChartCard title={t('analytics.channelActivity')} Icon={ForumIcon}>
          <ResponsiveContainer width="100%" height={Math.max(160, channels.length * 30)}>
            <BarChart data={channels.map(c => ({ name: c.name || c.hash.slice(0, 10), count: c.messageCount }))} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis type="number" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: md3.onSurface }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {channels.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('analytics.messageShare')} Icon={PieChartIcon}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={channels.slice(0, 8).map(c => ({ name: c.name || c.hash.slice(0, 8), value: c.messageCount }))}
                dataKey="value" cx="50%" cy="50%" outerRadius={85}
                label={({ name, percent }: { name?: string; percent?: number }) => (percent ?? 0) > 0.04 ? `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%` : ''}
                labelLine={false}
              >
                {channels.slice(0, 8).map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: md3.onSurfaceVariant }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      {analytics && (analytics.activityChannels.length > 0 || analytics.topSenders.length > 0) && (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mt: 2 }}>
          {analytics.activityChannels.length > 0 && (
            <ChartCard title={t('analytics.messagesPerHourByChannel')} Icon={ShowChartIcon}>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={actChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
                  <XAxis dataKey="displayLabel" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={0} />
                  <YAxis tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                    labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ''} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {analytics.activityChannels.map((ch, i) => (
                    <Area key={ch} type="monotone" dataKey={ch} stackId="1" stroke={chColor(ch, i)} fill={chColor(ch, i)} fillOpacity={0.35} strokeWidth={1.5} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {analytics.topSenders.length > 0 && (
            <ChartCard title={t('analytics.topSenders')} Icon={LeaderboardIcon}>
              <ResponsiveContainer width="100%" height={Math.max(160, analytics.topSenders.length * 26)}>
                <BarChart data={analytics.topSenders.map(s => ({ name: s.sender, count: s.messageCount, channels: s.channels }))} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: md3.onSurface }} />
                  <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                    formatter={(v: unknown, _: unknown, e: { payload?: { channels?: number } }) => [`${Number(v).toLocaleString()} (${e.payload?.channels ?? 0} ch)`, t('analytics.totalMessages')]} />
                  <Bar dataKey="count" fill={md3.tertiary} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </Box>
      )}

      <ChartCard title={t('analytics.channelRoster')} Icon={LeaderboardIcon} sx={{ mt: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 520 }}>
          <TableHead>
            <TableRow>
              {['#', t('analytics.channelCol'), t('packets.hash'), t('analytics.totalMessages'), t('analytics.share')].map(h => <TableCell key={h}>{h}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {channels.map((c, i) => (
              <TableRow key={c.hash}>
                <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: PALETTE[i % PALETTE.length], display: 'inline-block', mr: 1 }} />
                  {c.name || '—'}
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 10, color: md3.outline }}>{c.hash.slice(0, 16)}…</TableCell>
                <TableCell sx={{ color: '#ec4899', fontWeight: 700 }}>{c.messageCount.toLocaleString()}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>
                  {total > 0 ? `${((c.messageCount / total) * 100).toFixed(1)}%` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </Box>
      </ChartCard>
    </Box>
  )
}

// ── Hash Stats ─────────────────────────────────────────────────────────────────
function HashesTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()

  const navigate = useNavigate()

  type HashStats = {
    sizeDistribution: Record<string, number>
    byRole: Record<string, Record<string, number>>
    overTime: Array<{ label: string; size1: number; size2: number; size3: number; sizeN: number }>
    multiByteAdopters: Array<{ pubKey: string; name: string; count: number; maxSize: number }>
    inconsistentHashes: Array<{ pubKey: string; name: string; role: string; currentHash: string; currentSize: number; sizesSeen: number[] }>
    hashMatrices: ComponentProps<typeof HashMatrix>['matrices']
  }

  const [data, setData] = useState<HashStats | null>(null)
  useEffect(() => { api.analyticsHashes(params).then(setData) }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <TabLoading />

  const HASH_COLORS: Record<string, string> = { '1': '#22c55e', '2': '#f59e0b', '3': '#ec4899', '4+': md3.primary }

  // Merge 4+ bytes into one bucket
  const sizeDistMerged = [
    { label: '1 B',  count: data.sizeDistribution['1']  ?? 0 },
    { label: '2 B',  count: data.sizeDistribution['2']  ?? 0 },
    { label: '3 B',  count: data.sizeDistribution['3']  ?? 0 },
    { label: '4+ B', count: Object.entries(data.sizeDistribution).filter(([k]) => parseInt(k) >= 4).reduce((s, [, v]) => s + v, 0) },
  ].filter(d => d.count > 0)

  const byRepeater = data.byRole['repeater'] ?? {}
  const byRoleData = Object.entries(data.byRole).map(([role, sizes]) => ({
    role,
    '1 B':  sizes['1'] ?? 0,
    '2 B':  sizes['2'] ?? 0,
    '3 B':  sizes['3'] ?? 0,
    '4+ B': Object.entries(sizes).filter(([k]) => parseInt(k) >= 4).reduce((s, [, v]) => s + v, 0),
  }))

  const totalPkts = sizeDistMerged.reduce((s, d) => s + d.count, 0)
  const multiByteTotal = (data.sizeDistribution['2'] ?? 0) + Object.entries(data.sizeDistribution).filter(([k]) => parseInt(k) >= 3).reduce((s, [, v]) => s + v, 0)
  const multiBytePct = totalPkts > 0 ? ((multiByteTotal / totalPkts) * 100).toFixed(1) : '0'

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        {[
          { l: t('home.totalPackets'), v: totalPkts.toLocaleString(), c: md3.primary },
          { l: t('analytics.oneBytePkts'), v: (data.sizeDistribution['1'] ?? 0).toLocaleString(), c: '#22c55e' },
          { l: t('analytics.multiByte'),   v: `${multiByteTotal.toLocaleString()} (${multiBytePct}%)`, c: '#f59e0b' },
          { l: t('analytics.adopters'),    v: data.multiByteAdopters.length.toString(), c: '#ec4899' },
          { l: t('analytics.repeaterOneByte'), v: (byRepeater['1'] ?? 0).toLocaleString(), c: md3.tertiary },
        ].map(p => (
          <Box key={p.l} sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{p.l}{'  '}</Typography>
            <Typography variant="body2" sx={{ color: p.c, fontWeight: 700, display: 'inline' }}>{p.v}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ mb: 2 }}>
        <HashMatrix matrices={data.hashMatrices} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 2 }}>
        <ChartCard title={t('analytics.hashSizeDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={sizeDistMerged}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {sizeDistMerged.map((d, i) => (
                  <Cell key={i} fill={HASH_COLORS[d.label.replace(' ', '')] ?? md3.primary} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('analytics.byRole')} Icon={GroupWorkIcon}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={byRoleData}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="role" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="1 B"  stackId="a" fill="#22c55e" />
              <Bar dataKey="2 B"  stackId="a" fill="#f59e0b" />
              <Bar dataKey="3 B"  stackId="a" fill="#ec4899" />
              <Bar dataKey="4+ B" stackId="a" fill={md3.primary} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      <ChartCard title={t('analytics.hashSizeOverTime')} Icon={TimelineIcon} sx={{ mb: 2 }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.overTime}>
            <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={1} />
            <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
            <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="size1" name="1 B"  stroke="#22c55e" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="size2" name="2 B"  stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="size3" name="3 B"  stroke="#ec4899" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="sizeN" name="4+ B" stroke={md3.primary} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {data.multiByteAdopters.length > 0 && (
        <ChartCard title={t('analytics.multiByteAdopters', { count: data.multiByteAdopters.length })} Icon={LeaderboardIcon}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {['#', t('analytics.hopIdentifier'), t('analytics.occurrencesInPaths'), t('analytics.maxSize')].map(h => <TableCell key={h}>{h}</TableCell>)}
              </TableRow>
            </TableHead>
            <TableBody>
              {data.multiByteAdopters.map((a, i) => (
                <TableRow key={a.pubKey}>
                  <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: md3.onSurface }}>{a.pubKey.toUpperCase()}</TableCell>
                  <TableCell sx={{ color: '#f59e0b', fontWeight: 700 }}>{a.count.toLocaleString()}</TableCell>
                  <TableCell>
                    <Chip label={`${a.maxSize} B`} size="small" sx={{ fontSize: 10, height: 20, background: alpha('#ec4899', 0.15), color: '#ec4899' }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ChartCard>
      )}

      {(data.inconsistentHashes?.length ?? 0) > 0 && (
        <ChartCard title={t('analytics.inconsistentHashTitle')} Icon={WarningAmberIcon} sx={{ mt: 2 }}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 1.5, lineHeight: 1.5 }}>
            {t('analytics.inconsistentHashDesc1')}
            <Link href="https://github.com/meshcore-dev/MeshCore/commit/fcfdc5f" target="_blank" rel="noopener" sx={{ color: md3.primary }}>{t('analytics.inconsistentHashFirmwareBug')}</Link>
            {t('analytics.inconsistentHashDesc2')}
            <Link href="https://github.com/meshcore-dev/MeshCore/releases/tag/repeater-v1.14.1" target="_blank" rel="noopener" sx={{ color: md3.primary }}>repeater v1.14.1</Link>
            {t('analytics.inconsistentHashDesc3')}
          </Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 560 }}>
              <TableHead>
                <TableRow>
                  {[t('common.name'), t('common.role'), t('analytics.inconsistentHashCurrent'), t('analytics.inconsistentHashSizesSeen')].map(h => <TableCell key={h}>{h}</TableCell>)}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.inconsistentHashes.map(n => {
                  const rc = n.role === 'repeater' ? '#dc2626' : n.role === 'room' ? '#0ea5e9' : md3.outline
                  return (
                    <TableRow key={n.pubKey}>
                      <TableCell>
                        <Box component="span" onClick={() => navigate(`/nodes/${encodeURIComponent(n.pubKey)}?section=node-packets`)}
                          sx={{ fontWeight: 600, color: md3.primary, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>
                          {n.name || n.pubKey.slice(0, 12)}
                        </Box>
                      </TableCell>
                      <TableCell><Chip label={n.role} size="small" sx={{ background: alpha(rc, 0.15), color: rc, fontSize: 11, height: 20 }} /></TableCell>
                      <TableCell>
                        <Box component="code" sx={{ fontFamily: 'monospace', fontWeight: 700, color: md3.onSurface }}>{n.currentHash}</Box>
                        <Box component="span" sx={{ color: md3.outline, ml: 0.75, fontSize: 11 }}>({n.currentSize}B)</Box>
                      </TableCell>
                      <TableCell>
                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                          {n.sizesSeen.map(sz => {
                            const sc = HASH_SIZE_BADGE[sz] ?? { bg: md3.primary, fg: '#fff' }
                            return <Chip key={sz} label={`${sz}B`} size="small" sx={{ background: sc.bg, color: sc.fg, fontSize: 10, height: 18, fontFamily: 'monospace', '& .MuiChip-label': { px: 0.75 } }} />
                          })}
                        </Box>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Box>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mt: 1 }}>
            {t('analytics.inconsistentHashAffected', { count: data.inconsistentHashes.length })}
          </Typography>
        </ChartCard>
      )}
    </Box>
  )
}

// Self-hash size badge palette used by the inconsistent-hash table.
const HASH_SIZE_BADGE: Record<number, { bg: string; fg: string }> = {
  1: { bg: '#f97316', fg: '#fff' },
  2: { bg: '#86efac', fg: '#064e3b' },
  3: { bg: '#16a34a', fg: '#fff' },
}

// ── Distance / Hop Analytics ──────────────────────────────────────────────────
function DistanceTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()

  type DistData = {
    totalHops: number
    pathsAnalyzed: number
    avgHopDist: number
    maxHopDist: number
    byLinkType: { direct: number; singleRelay: number; multiRelay: number }
    hopDistribution: Array<{ hops: number; count: number }>
    activityByHour: Array<{ hour: string; label: string; avgHops: number; count: number }>
    top20Hops: Array<{ hash: string; firstSeen: string; hopCount: number; hops: string[]; observerName: string; observerIata: string; routeType: number; payloadType: number }>
    top10MultiHop: Array<{ hash: string; firstSeen: string; maxHops: number; bestPath: string[]; routeType: number; payloadType: number; obsCount: number }>
    geo: {
      nodesWithPos: number
      totalPairs: number
      maxDistKm: number
      avgDistKm: number
      distribution: Array<{ label: string; count: number }>
      topPairs: Array<{ nodeAName: string; nodeAPubKey: string; nodeBName: string; nodeBPubKey: string; distKm: number }>
    }
  }

  const navigate = useNavigate()
  const [data, setData] = useState<DistData | null>(null)
  useEffect(() => { api.analyticsDistance(params).then(setData) }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <TabLoading />
  if (data.pathsAnalyzed === 0 && data.byLinkType.direct === 0)
    return <Typography sx={{ color: md3.onSurfaceVariant, p: 4 }}>{t('analytics.noDistData')}</Typography>

  const PAYLOAD_NAMES: Record<number, string> = {
    0: 'REQ', 1: 'RESPONSE', 2: 'TXT_MSG', 3: 'ACK', 4: 'ADVERT',
    5: 'GRP_TXT', 6: 'GRP_DATA', 7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE',
    10: 'MULTIPART', 11: 'CONTROL', 15: 'RAW_CUSTOM',
  }
  const ROUTE_NAMES: Record<number, string> = { 0: 'T_FLOOD', 1: 'FLOOD', 2: 'DIRECT', 3: 'T_DIRECT' }

  const linkTypeData = [
    { name: t('analytics.nodeToNode'), value: data.byLinkType.direct,      fill: '#22c55e' },
    { name: t('analytics.rptToNode'),  value: data.byLinkType.singleRelay, fill: '#f59e0b' },
    { name: t('analytics.rptToRpt'),   value: data.byLinkType.multiRelay,  fill: md3.primary },
  ]
  const totalObs = linkTypeData.reduce((s, d) => s + d.value, 0)

  return (
    <Box>
      {/* Stat pills */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.5, mb: 2 }}>
        {[
          { l: t('analytics.totalHopsAnalyzed'), v: data.totalHops.toLocaleString(),              c: md3.primary },
          { l: t('analytics.pathsAnalyzed'),     v: data.pathsAnalyzed.toLocaleString(),          c: '#14b8a6' },
          { l: t('analytics.avgHopDist'),        v: data.avgHopDist.toFixed(2) + ' ' + t('analytics.hopsLabel'), c: '#f59e0b' },
          { l: t('analytics.maxHopDist'),        v: data.maxHopDist + ' ' + t('analytics.hopsLabel'),            c: '#ec4899' },
        ].map(p => (
          <Box key={p.l} sx={{ px: 1.5, py: 1, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.25 }}>{p.l}</Typography>
            <Typography variant="body2" sx={{ color: p.c, fontWeight: 700 }}>{p.v}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mb: 2 }}>
        {/* Distance by Link Type */}
        <ChartCard title={t('analytics.byLinkType')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={linkTypeData} layout="vertical" margin={{ left: 8, right: 48, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: md3.onSurface }} width={90} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                formatter={(v) => [`${Number(v).toLocaleString()} (${totalObs > 0 ? ((Number(v) / totalObs) * 100).toFixed(1) : 0}%)`, '']} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 10, fill: md3.onSurfaceVariant, formatter: (v: unknown) => totalObs > 0 ? `${((Number(v) / totalObs) * 100).toFixed(0)}%` : '' }}>
                {linkTypeData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Hop Distance Distribution */}
        <ChartCard title={t('analytics.hopDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.hopDistribution} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="hops" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} label={{ value: t('analytics.hopsLabel'), position: 'insideBottom', offset: -2, fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                labelFormatter={v => `${v} ${t('analytics.hopsLabel')}`} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {data.hopDistribution.map((d, i) => (
                  <Cell key={i} fill={d.hops === 0 ? '#22c55e' : d.hops === 1 ? '#f59e0b' : alpha(md3.primary, Math.min(1, 0.5 + d.hops * 0.15))} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      {/* Average Distance Over Time */}
      <ChartCard title={t('analytics.avgDistOverTime')} Icon={TimelineIcon} sx={{ mb: 2 }}>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data.activityByHour} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={3} />
            <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
            <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
              formatter={(v) => [Number(v).toFixed(2) + ' ' + t('analytics.hopsLabel'), t('analytics.avgHopDist')]} />
            <ReferenceLine y={data.avgHopDist} stroke={alpha(md3.primary, 0.4)} strokeDasharray="4 4" />
            <Line type="monotone" dataKey="avgHops" stroke={md3.primary} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Top 20 Longest Hops */}
      <ChartCard title={t('analytics.top20Hops')} Icon={LeaderboardIcon} sx={{ mb: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {['#', t('analytics.hopsLabel'), t('analytics.path'), t('analytics.type'), t('analytics.observer'), t('common.firstSeen')].map(h => (
                <TableCell key={h} sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {data.top20Hops.map((row, i) => (
              <TableRow key={`${row.hash}-${i}`} sx={{ cursor: 'pointer', '&:hover': { background: alpha(md3.primary, 0.06) } }}
                onClick={() => navigate(`/packets?hash=${row.hash}`)}>
                <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                <TableCell>
                  <Chip label={`${row.hopCount} ${t('analytics.hopsLabel')}`} size="small"
                    sx={{ fontSize: 11, height: 20, background: alpha('#ec4899', 0.15), color: '#ec4899', fontWeight: 700 }} />
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: md3.onSurfaceVariant, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.hops.join(' → ') || '—'}
                </TableCell>
                <TableCell sx={{ fontSize: 11 }}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                    <Typography sx={{ fontSize: 10, color: md3.primary }}>{ROUTE_NAMES[row.routeType] ?? row.routeType}</Typography>
                    <Typography sx={{ fontSize: 10, color: md3.onSurfaceVariant }}>{PAYLOAD_NAMES[row.payloadType] ?? row.payloadType}</Typography>
                  </Box>
                </TableCell>
                <TableCell sx={{ color: md3.onSurface, fontSize: 12 }}>{row.observerName ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={row.observerIata} size={12} />{row.observerName}</Box> : (row.observerIata ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={row.observerIata} size={12} />{row.observerIata}</Box> : '—')}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11, whiteSpace: 'nowrap' }}>
                  {row.firstSeen ? new Date(row.firstSeen).toLocaleString() : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ChartCard>

      {/* Top 10 Multi-Hop Paths */}
      {data.top10MultiHop.length > 0 && (
        <ChartCard title={t('analytics.top10Paths')} Icon={AccountTreeIcon}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {['#', t('analytics.maxHops'), t('analytics.path'), t('analytics.type'), t('packets.obsCount'), t('common.firstSeen')].map(h => (
                  <TableCell key={h} sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {data.top10MultiHop.map((row, i) => (
                <TableRow key={row.hash} sx={{ cursor: 'pointer', '&:hover': { background: alpha(md3.primary, 0.06) } }}
                  onClick={() => navigate(`/packets?hash=${row.hash}`)}>
                  <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                  <TableCell>
                    <Chip label={`${row.maxHops} ${t('analytics.hopsLabel')}`} size="small"
                      sx={{ fontSize: 11, height: 20, background: alpha(md3.primary, 0.15), color: md3.primary, fontWeight: 700 }} />
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: md3.onSurfaceVariant, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.bestPath.join(' → ') || '—'}
                  </TableCell>
                  <TableCell sx={{ fontSize: 11 }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                      <Typography sx={{ fontSize: 10, color: md3.primary }}>{ROUTE_NAMES[row.routeType] ?? row.routeType}</Typography>
                      <Typography sx={{ fontSize: 10, color: md3.onSurfaceVariant }}>{PAYLOAD_NAMES[row.payloadType] ?? row.payloadType}</Typography>
                    </Box>
                  </TableCell>
                  <TableCell sx={{ color: '#f59e0b', fontWeight: 700 }}>{row.obsCount}</TableCell>
                  <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11, whiteSpace: 'nowrap' }}>
                    {row.firstSeen ? new Date(row.firstSeen).toLocaleString() : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ChartCard>
      )}

      {/* ── Geographic Coverage ── */}
      {(!data.geo || data.geo.nodesWithPos < 2) ? (
        <ChartCard title={t('analytics.geoTitle')} Icon={ScatterPlotIcon} sx={{ mt: 2 }}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('analytics.noGeoData')}</Typography>
        </ChartCard>
      ) : (
        <Box sx={{ mt: 2 }}>
          {/* Geo stat pills */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.5, mb: 2 }}>
            {[
              { l: t('analytics.nodesWithPos'), v: (data.geo?.nodesWithPos ?? 0).toString(),                c: '#14b8a6' },
              { l: t('analytics.totalPairs'),   v: (data.geo?.totalPairs ?? 0).toLocaleString(),            c: md3.primary },
              { l: t('analytics.maxDistKm'),    v: (data.geo?.maxDistKm ?? 0).toLocaleString() + ' km',    c: '#ec4899' },
              { l: t('analytics.avgDistKm'),    v: (data.geo?.avgDistKm ?? 0).toLocaleString() + ' km',    c: '#f59e0b' },
            ].map(p => (
              <Box key={p.l} sx={{ px: 1.5, py: 1, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
                <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.25 }}>{p.l}</Typography>
                <Typography variant="body2" sx={{ color: p.c, fontWeight: 700 }}>{p.v}</Typography>
              </Box>
            ))}
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mb: 2 }}>
            {/* Distance distribution */}
            <ChartCard title={t('analytics.geoDistribution')} Icon={BarChartIcon}>
              <ResponsiveContainer width="100%" height={Math.max(160, (data.geo?.distribution?.length ?? 0) * 32)}>
                <BarChart data={data.geo?.distribution ?? []} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
                  <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: md3.onSurface }} width={80} />
                  <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {(data.geo?.distribution ?? []).map((_, i) => (
                      <Cell key={i} fill={alpha(md3.primary, 0.4 + (i / (data.geo?.distribution?.length || 1)) * 0.6)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Top links table */}
            <ChartCard title={t('analytics.topLinks')} Icon={LeaderboardIcon}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {['#', t('analytics.nodeA'), t('analytics.nodeB'), t('analytics.distKm')].map(h => (
                      <TableCell key={h} sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(data.geo?.topPairs ?? []).map((p, i) => (
                    <TableRow key={`${p.nodeAPubKey}-${p.nodeBPubKey}`}>
                      <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontWeight: 600, color: md3.onSurface, display: 'block' }}>{p.nodeAName || '—'}</Typography>
                        <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10 }}>{p.nodeAPubKey.slice(0, 12)}…</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontWeight: 600, color: md3.onSurface, display: 'block' }}>{p.nodeBName || '—'}</Typography>
                        <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10 }}>{p.nodeBPubKey.slice(0, 12)}…</Typography>
                      </TableCell>
                      <TableCell>
                        <Chip label={`${p.distKm.toLocaleString()} km`} size="small"
                          sx={{ fontSize: 11, height: 20, background: alpha('#ec4899', 0.15), color: '#ec4899', fontWeight: 700 }} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ChartCard>
          </Box>
        </Box>
      )}
    </Box>
  )
}

// ── Scope Analytics ──────────────────────────────────────────────────────────
function ScopeTab({ params, filterKey }: TabProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()

  type ScopeData = {
    distribution: Array<{ scope: string; pktCount: number; obsCount: number }>
    rfByScope: Array<{ scope: string; avgSnr: number; avgRssi: number; obsCount: number }>
    topObservers: Array<{ scope: string; observerId: string; observerName: string; observerIata: string; count: number }>
    activityScopes: string[]
    activity: Array<{ hour: string; label: string; counts: Record<string, number> }>
  }

  const [data, setData] = useState<ScopeData | null>(null)
  useEffect(() => { api.analyticsScope(params).then(setData) }, [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <TabLoading />

  const knownScopes = data.distribution.filter(d => d.scope !== 'unknown')
  const unknownBucket = data.distribution.find(d => d.scope === 'unknown')
  const totalScoped = knownScopes.reduce((s, d) => s + d.pktCount, 0)
  const totalUnscoped = unknownBucket?.pktCount ?? 0

  if (data.distribution.length === 0) {
    return <Typography sx={{ color: md3.onSurfaceVariant, p: 4 }}>{t('analytics.noScopeData')}</Typography>
  }

  const SCOPE_COLORS = ['#D0BCFF', '#22c55e', '#f59e0b', '#14b8a6', '#ec4899', '#a855f7', '#0ea5e9']
  const scopeColor = (scope: string, idx: number) =>
    scope === 'unknown' ? md3.outline : SCOPE_COLORS[idx % SCOPE_COLORS.length]

  // Build activity chart data: each row gets one key per scope
  const activityChartData = data.activity.map(h => {
    const row: Record<string, string | number> = { label: h.label }
    for (const sc of data.activityScopes) row[sc] = h.counts[sc] ?? 0
    return row
  })

  // Group topObservers by scope for the table
  const scopeGroups = data.distribution.map(d => ({
    scope: d.scope,
    pktCount: d.pktCount,
    obsCount: d.obsCount,
    observers: data.topObservers.filter(o => o.scope === d.scope),
  }))

  return (
    <Box>
      {/* Stat pills */}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        {[
          { l: t('analytics.totalScopes'),    v: knownScopes.length.toString(),         c: md3.primary },
          { l: t('analytics.scopedPackets'),   v: totalScoped.toLocaleString(),          c: '#22c55e' },
          { l: t('analytics.unscopedPackets'), v: totalUnscoped.toLocaleString(),        c: md3.outline },
        ].map(p => (
          <Box key={p.l} sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{p.l}{'  '}</Typography>
            <Typography variant="body2" sx={{ color: p.c, fontWeight: 700, display: 'inline' }}>{p.v}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mb: 2 }}>
        {/* Scope distribution */}
        <ChartCard title={t('analytics.scopeDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={Math.max(160, data.distribution.length * 36)}>
            <BarChart data={data.distribution} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis type="category" dataKey="scope" tick={{ fontSize: 11, fill: md3.onSurface }} width={72} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                formatter={(v, name) => [Number(v).toLocaleString(), name === 'pktCount' ? t('common.packets') : t('home.observations')]} />
              <Bar dataKey="pktCount" name="pktCount" radius={[0, 4, 4, 0]}>
                {data.distribution.map((d, i) => <Cell key={d.scope} fill={scopeColor(d.scope, i)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* RF quality by scope */}
        <ChartCard title={t('analytics.rfByScope')} Icon={SignalCellularAltIcon}>
          <ResponsiveContainer width="100%" height={Math.max(160, data.rfByScope.length * 36)}>
            <BarChart data={data.rfByScope} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis type="category" dataKey="scope" tick={{ fontSize: 11, fill: md3.onSurface }} width={72} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }}
                formatter={(v, name) => [`${Number(v).toFixed(1)}${name === 'avgSnr' ? ' dB' : ' dBm'}`, name === 'avgSnr' ? t('home.avgSnr') : t('home.avgRssi')]} />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={n => n === 'avgSnr' ? t('home.avgSnr') : t('home.avgRssi')} />
              <Bar dataKey="avgSnr"  name="avgSnr"  fill="#14b8a6" radius={[0, 4, 4, 0]} />
              <Bar dataKey="avgRssi" name="avgRssi" fill="#ec4899" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      {/* 24h activity */}
      {data.activityScopes.length > 0 && (
        <ChartCard title={t('analytics.scopeActivity')} Icon={ShowChartIcon} sx={{ mb: 2 }}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={activityChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} interval={3} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {data.activityScopes.map((sc, i) => (
                <Area key={sc} type="monotone" dataKey={sc} stackId="1"
                  stroke={scopeColor(sc, i)} fill={alpha(scopeColor(sc, i), 0.5)} strokeWidth={1.5} dot={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Top observers per scope */}
      <ChartCard title={t('analytics.topObserversByScope')} Icon={LeaderboardIcon}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {[t('analytics.scope'), t('common.name'), t('common.location'), t('common.packets')].map(h => (
                <TableCell key={h} sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {scopeGroups.map(g => g.observers.length === 0 ? null : g.observers.map((o, idx) => (
              <TableRow key={`${g.scope}-${o.observerId}`}>
                {idx === 0 ? (
                  <TableCell rowSpan={g.observers.length} sx={{ verticalAlign: 'top', pt: 1.5 }}>
                    <Chip label={g.scope} size="small"
                      sx={{ fontSize: 11, height: 20,
                        background: alpha(scopeColor(g.scope, data.distribution.findIndex(d => d.scope === g.scope)), 0.15),
                        color: scopeColor(g.scope, data.distribution.findIndex(d => d.scope === g.scope)),
                        fontWeight: 700 }} />
                  </TableCell>
                ) : null}
                <TableCell sx={{ fontWeight: idx === 0 ? 600 : 400, color: md3.onSurface }}>{o.observerName || o.observerId.slice(0, 8)}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{o.observerIata ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={o.observerIata} size={12} />{o.observerIata}</Box> : '—'}</TableCell>
                <TableCell sx={{ color: '#f59e0b', fontWeight: 700 }}>{o.count.toLocaleString()}</TableCell>
              </TableRow>
            )))}
          </TableBody>
        </Table>
      </ChartCard>
    </Box>
  )
}

// ── shared helpers ────────────────────────────────────────────────────────────
// Animated placeholder shown while a tab's data is loading — a row of stat-pill
// skeletons plus two chart-card skeletons, mirroring the real tab layouts.
function TabLoading() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const shimmer = alpha(md3.onSurface, 0.06)
  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} variant="rounded" animation="wave" width={150} height={46} sx={{ borderRadius: 2, bgcolor: shimmer }} />
        ))}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <Skeleton variant="rounded" animation="wave" width={26} height={26} sx={{ bgcolor: shimmer }} />
                <Skeleton variant="text" animation="wave" width={170} sx={{ bgcolor: shimmer }} />
              </Box>
              <Skeleton variant="rounded" animation="wave" height={220} sx={{ bgcolor: shimmer }} />
            </CardContent>
          </Card>
        ))}
      </Box>
    </Box>
  )
}

function ChartCard({ title, Icon, children, sx }: { title: string; Icon?: SvgIconComponent; children: React.ReactNode; sx?: object }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  return (
    <Card sx={sx}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
          {Icon && (
            <Box sx={{ width: 26, height: 26, borderRadius: 1.5, background: alpha(md3.primary, 0.12), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon sx={{ fontSize: 16, color: md3.primary }} />
            </Box>
          )}
          <Typography variant="subtitle2" sx={{ color: md3.onSurfaceVariant }}>{title}</Typography>
        </Box>
        {children}
      </CardContent>
    </Card>
  )
}

function fmtUptime(secs: number) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3600) / 60)}m`
}
