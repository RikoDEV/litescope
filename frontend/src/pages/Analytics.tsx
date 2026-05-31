import { useEffect, useState } from 'react'
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
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { api } from '../services/api'
import type { Node, Observer, OverviewStats } from '../types'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ScatterChart, Scatter, CartesianGrid,
  AreaChart, Area, ReferenceLine,
} from 'recharts'
import AssessmentIcon from '@mui/icons-material/Assessment'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt'
import RouterIcon from '@mui/icons-material/Router'
import WifiIcon from '@mui/icons-material/Wifi'
import PieChartIcon from '@mui/icons-material/PieChart'
import BarChartIcon from '@mui/icons-material/BarChart'
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot'
import LeaderboardIcon from '@mui/icons-material/Leaderboard'
import DonutLargeIcon from '@mui/icons-material/DonutLarge'
import type { SvgIconComponent } from '@mui/icons-material'

type TabId = 'overview' | 'activity' | 'rf' | 'nodes' | 'observers'

const TABS: { id: TabId; Icon: SvgIconComponent }[] = [
  { id: 'overview',  Icon: AssessmentIcon },
  { id: 'activity',  Icon: ShowChartIcon },
  { id: 'rf',        Icon: SignalCellularAltIcon },
  { id: 'nodes',     Icon: RouterIcon },
  { id: 'observers', Icon: WifiIcon },
]

const PALETTE = ['#D0BCFF','#EFB8C8','#22c55e','#f59e0b','#14b8a6','#a855f7']

export default function Analytics() {
  const theme = useTheme()
  const md3   = theme.palette.md3
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabId>('overview')

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', background: md3.background }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
        sx={{ px: 2, background: md3.surfaceContainerLow, flexShrink: 0 }}>
        {TABS.map(({ id, Icon }) => (
          <Tab key={id} value={id} iconPosition="start" icon={<Icon sx={{ fontSize: 18 }} />} label={t(`analytics.${id === 'rf' ? 'rfSignal' : id}`)} sx={{ minHeight: 48 }} />
        ))}
      </Tabs>
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {tab === 'overview'  && <OverviewTab />}
        {tab === 'activity'  && <ActivityTab />}
        {tab === 'rf'        && <RFTab />}
        {tab === 'nodes'     && <NodesTab />}
        {tab === 'observers' && <ObserversTab />}
      </Box>
    </Box>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────
function OverviewTab() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [stats, setStats] = useState<OverviewStats | null>(null)
  const [byType, setByType] = useState<Record<string, number>>({})
  const [rf, setRF] = useState<{ snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number }; totalObservations: number } | null>(null)

  useEffect(() => {
    api.overview().then(setStats)
    api.packetsByType().then(setByType)
    api.analyticsRF().then(d => setRF({ snrSummary: d.snrSummary, rssiSummary: d.rssiSummary, totalObservations: d.totalObservations }))
  }, [])

  const typeData = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))

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
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={typeData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} />
                <XAxis type="number" tick={{ fontSize: 11, fill: md3.onSurfaceVariant }} />
                <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11, fill: md3.onSurface }} />
                <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
                <Bar dataKey="value" fill={md3.primary} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title={t('analytics.payloadTypeShare')} Icon={PieChartIcon}>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={typeData} dataKey="value" cx="50%" cy="50%" outerRadius={80}
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                  {typeData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12, color: md3.onSurfaceVariant }} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </Box>
      )}
    </Box>
  )
}

// ── Activity ──────────────────────────────────────────────────────────────────
function ActivityTab() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [hours, setHours] = useState(24)
  const [data, setData]   = useState<Array<{ hour: string; label: string; count: number }>>([])

  useEffect(() => { api.analyticsActivity(hours).then(setData) }, [hours])

  const peak  = data.reduce((m, b) => b.count > m ? b.count : m, 0)
  const total = data.reduce((s, b) => s + b.count, 0)
  const avg   = data.length > 0 ? total / data.length : 0
  const step  = hours <= 24 ? 4 : hours <= 72 ? 12 : 24
  const chartData = data.map((b, i) => ({ ...b, displayLabel: i % step === 0 ? b.label : '' }))

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <ToggleButtonGroup exclusive value={hours} onChange={(_, v) => v && setHours(v)} size="small">
          {[{ h: 24, l: '24 h' }, { h: 72, l: '3 d' }, { h: 168, l: '7 d' }].map(w => (
            <ToggleButton key={w.h} value={w.h} sx={{ fontSize: 12 }}>{w.l}</ToggleButton>
          ))}
        </ToggleButtonGroup>
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

      <ChartCard title={t('analytics.packetsPerHourWindow', { hours })} Icon={ShowChartIcon}>
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
    </Box>
  )
}

// ── RF / Signal ───────────────────────────────────────────────────────────────
function RFTab() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [rf, setRF] = useState<{ rssi: number[]; snr: number[]; snrSummary: { avg: number; min: number; max: number }; rssiSummary: { avg: number; min: number; max: number }; totalObservations: number } | null>(null)
  useEffect(() => { api.analyticsRF().then(setRF) }, [])
  if (!rf) return <Typography sx={{ color: md3.onSurfaceVariant, p: 4 }}>{t('common.loading')}</Typography>
  const snr  = rf.snr  ?? []
  const rssi = rf.rssi ?? []
  if (rf.totalObservations === 0 || (snr.length === 0 && rssi.length === 0)) return <Typography sx={{ color: md3.onSurfaceVariant, p: 4 }}>{t('analytics.noRf')}</Typography>

  const snrB  = bucketize(snr,  -25, 15, 16)
  const rssiB = bucketize(rssi, -125, -30, 19)
  const step  = Math.max(1, Math.floor(snr.length / 400))
  const scatter = snr.filter((_, i) => i % step === 0).map((s, i) => ({ snr: s, rssi: rssi[i * step] ?? 0 }))

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        {[
          { l: t('home.observations'), v: rf.totalObservations.toLocaleString(), c: md3.primary },
          { l: t('home.avgSnr'), v: `${rf.snrSummary.avg.toFixed(1)} dB`, c: '#22c55e' },
          { l: `Min SNR`, v: `${rf.snrSummary.min.toFixed(1)} dB`, c: md3.error },
          { l: t('home.avgRssi'), v: `${rf.rssiSummary.avg.toFixed(0)} dBm`, c: md3.tertiary },
          { l: `Min RSSI`, v: `${rf.rssiSummary.min.toFixed(0)} dBm`, c: md3.error },
        ].map(p => (
          <Box key={p.l} sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{p.l}  </Typography>
            <Typography variant="body2" sx={{ color: p.c, fontWeight: 700, display: 'inline' }}>{p.v}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 2 }}>
        <ChartCard title={t('analytics.snrDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={snrB}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {snrB.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > 6 ? '#22c55e' : parseFloat(b.label) > 0 ? '#f59e0b' : md3.error} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title={t('analytics.rssiDistribution')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rssiB}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.4)} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <YAxis tick={{ fontSize: 10, fill: md3.onSurfaceVariant }} />
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {rssiB.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > -80 ? '#22c55e' : parseFloat(b.label) > -100 ? '#f59e0b' : md3.error} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

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
function NodesTab() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [nodes, setNodes] = useState<Node[]>([])
  useEffect(() => { api.analyticsNodesTop(25).then(setNodes) }, [])

  const roleColor = (r: string) => ({ repeater: md3.primary, companion: md3.tertiary, room: '#22c55e', sensor: '#f59e0b' }[r] ?? md3.outline)
  const roleCounts: Record<string, number> = {}
  for (const n of nodes) roleCounts[n.role] = (roleCounts[n.role] ?? 0) + 1
  const rolePie = Object.entries(roleCounts).map(([name, value]) => ({ name, value }))

  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 2, mb: 2 }}>
        <ChartCard title={t('analytics.topNodesByAdvert')} Icon={BarChartIcon}>
          <ResponsiveContainer width="100%" height={Math.max(180, nodes.length * 26)}>
            <BarChart data={nodes.map(n => ({ name: n.name || n.pubKey.slice(0, 8), count: n.advertCount, role: n.role }))} layout="vertical">
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
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={rolePie} dataKey="value" cx="50%" cy="50%" outerRadius={75}
                label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                {rolePie.map((e, i) => <Cell key={i} fill={roleColor(e.name)} />)}
              </Pie>
              <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>

      <ChartCard title={t('analytics.leaderboard')} Icon={LeaderboardIcon}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {['#', t('common.name'), t('common.role'), t('common.adverts'), t('common.lastSeen'), t('common.location')].map(h => <TableCell key={h}>{h}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {nodes.map((n, i) => (
              <TableRow key={n.pubKey}>
                <TableCell sx={{ color: md3.outline }}>{i + 1}</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{n.name || n.pubKey.slice(0, 12) + '…'}</TableCell>
                <TableCell><Chip label={n.role} size="small" sx={{ background: alpha(roleColor(n.role), 0.15), color: roleColor(n.role), fontSize: 11, height: 20 }} /></TableCell>
                <TableCell sx={{ color: md3.primary, fontWeight: 700 }}>{n.advertCount.toLocaleString()}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{new Date(n.lastSeen).toLocaleDateString()}</TableCell>
                <TableCell sx={{ color: md3.onSurfaceVariant, fontSize: 11 }}>{n.lat != null ? `${n.lat.toFixed(2)}, ${n.lon?.toFixed(2)}` : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ChartCard>
    </Box>
  )
}

// ── Observers ─────────────────────────────────────────────────────────────────
function ObserversTab() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [observers, setObservers] = useState<Observer[]>([])
  useEffect(() => { api.analyticsObserversTop(20).then(setObservers) }, [])

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
        <Table size="small">
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
                  <TableCell sx={{ color: md3.tertiary, fontWeight: 700 }}>{o.iata || '—'}</TableCell>
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
      </ChartCard>
    </Box>
  )
}

// ── shared helpers ────────────────────────────────────────────────────────────
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

function bucketize(vals: number[], min: number, max: number, buckets: number) {
  const size = (max - min) / buckets
  const counts = Array(buckets).fill(0)
  for (const v of vals) counts[Math.min(buckets - 1, Math.max(0, Math.floor((v - min) / size)))]++
  return counts.map((count, i) => ({ label: `${(min + i * size).toFixed(0)}`, count }))
}

function fmtUptime(secs: number) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3600) / 60)}m`
}
