import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import CircularProgress from '@mui/material/CircularProgress'
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt'
import RouterIcon from '@mui/icons-material/Router'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer,
  CartesianGrid, Cell, PieChart, Pie, LineChart, Line, Legend,
} from 'recharts'
import { formatDistanceToNow, format, subHours } from 'date-fns'
import { useDateLocale } from '../hooks/useDateLocale'
import { useRef } from 'react'
import L from 'leaflet'
import { api } from '../services/api'
import type { Node, NodeOverview, Packet, RFStats, RichPacket } from '../types'
import { PAYLOAD_NAMES, PAYLOAD_COLORS } from '../types'
import { bucketize } from '../utils/stats'
import { isNodeActive as isActive } from '../utils/nodes'
import { roleColor } from '../utils/roles'

// ── helpers ──────────────────────────────────────────────────────────────────

function buildActivityChart(packets: Packet[]): Array<{ label: string; count: number }> {
  const now = Date.now()
  const buckets: Record<string, number> = {}
  for (let i = 23; i >= 0; i--) {
    const label = format(subHours(now, i), 'HH:mm')
    buckets[label] = 0
  }
  for (const p of packets) {
    const t = new Date(p.firstSeen).getTime()
    const hoursAgo = Math.floor((now - t) / 3600e3)
    if (hoursAgo >= 24) continue
    const label = format(subHours(now, hoursAgo), 'HH:mm')
    buckets[label] = (buckets[label] ?? 0) + 1
  }
  return Object.entries(buckets).map(([label, count]) => ({ label, count }))
}

function buildTypeChart(packets: Packet[]) {
  const counts: Record<string, number> = {}
  for (const p of packets) {
    const name = PAYLOAD_NAMES[p.payloadType] ?? String(p.payloadType)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))
}

function buildSnrTrend(packets: RichPacket[]) {
  return [...packets]
    .filter(p => p.bestSnr != null)
    .sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime())
    .map(p => ({ label: format(new Date(p.firstSeen), 'HH:mm'), snr: p.bestSnr!, rssi: p.bestRssi ?? undefined }))
}

// ── mini map ─────────────────────────────────────────────────────────────────
function NodeMiniMap({ lat, lon, color }: { lat: number; lon: number; color: string }) {
  const divRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!divRef.current) return
    const map = L.map(divRef.current, {
      center: [lat, lon], zoom: 13,
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
    L.circleMarker([lat, lon], { radius: 9, color: '#fff', fillColor: color, fillOpacity: 1, weight: 2.5 }).addTo(map)
    // The map fills a flex container whose height depends on a sibling card that
    // loads asynchronously — re-measure when the container is resized.
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(divRef.current)
    return () => { ro.disconnect(); map.remove() }
  }, [lat, lon, color])
  return <div ref={divRef} style={{ height: '100%', minHeight: 200, borderRadius: 8, overflow: 'hidden' }} />
}

// ── stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  return (
    <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 3, px: 2, py: 1.5, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</Typography>
      <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1.2rem', color: color ?? 'inherit', lineHeight: 1.2 }}>{value}</Typography>
      {sub && <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10 }}>{sub}</Typography>}
    </Box>
  )
}

// ── section header ────────────────────────────────────────────────────────────
function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
      <Box sx={{ color: md3.primary, display: 'flex', alignItems: 'center' }}>{icon}</Box>
      <Typography variant="overline" sx={{ color: md3.onSurfaceVariant, fontSize: 11, lineHeight: 1 }}>{label}</Typography>
    </Box>
  )
}

// ── card wrapper ──────────────────────────────────────────────────────────────
function Card({ children, sx }: { children: React.ReactNode; sx?: object }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  return (
    <Box sx={{ background: md3.surfaceContainerLow, borderRadius: 3, border: `1px solid ${md3.outlineVariant}`, p: 2, ...sx }}>
      {children}
    </Box>
  )
}

// ── main page ─────────────────────────────────────────────────────────────────
export default function NodePage() {
  const { pubkey } = useParams<{ pubkey: string }>()
  const navigate   = useNavigate()
  const theme      = useTheme(); const md3 = theme.palette.md3
  const { t }      = useTranslation()
  const dateLocale = useDateLocale()

  const [node,     setNode]     = useState<Node | null>(null)
  const [overview, setOverview] = useState<NodeOverview | null>(null)
  const [rf,       setRF]       = useState<RFStats | null>(null)
  const [packets,  setPackets]  = useState<Packet[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(false)

  useEffect(() => {
    if (!pubkey) return
    api.nodes().then(res => {
      const n = (res.nodes ?? []).find(x => x.pubKey === pubkey)
      if (!n) { setError(true); setLoading(false); return }
      setNode(n)
      document.title = `${n.name || n.pubKey.slice(0, 16)} — liteScope`
      Promise.all([
        api.nodeOverview(pubkey),
        api.nodeRF(pubkey),
        api.nodePackets(pubkey, 50),
      ]).then(([ov, rfData, pkts]) => {
        setOverview(ov)
        setRF(rfData)
        setPackets(pkts)
      }).finally(() => setLoading(false))
    }).catch(() => { setError(true); setLoading(false) })
  }, [pubkey])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={32} />
      </Box>
    )
  }

  if (error || !node) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
        <Typography variant="body1" sx={{ color: md3.onSurfaceVariant }}>Node not found</Typography>
        <IconButton onClick={() => navigate(-1)}><ArrowBackIcon /></IconButton>
      </Box>
    )
  }

  const color       = roleColor(node.role, md3)
  const active      = isActive(node)
  const snrBuckets  = rf?.snr?.length  ? bucketize(rf.snr,  -25, 15,   10) : []
  const rssiBuckets = rf?.rssi?.length ? bucketize(rf.rssi, -120, -40, 10) : []
  const allPackets   = overview?.recentPackets ?? []
  const activityData = buildActivityChart(packets)
  const typeData     = buildTypeChart(packets)
  const snrTrend     = buildSnrTrend(allPackets)

  const CHART_STYLE = {
    contentStyle: { background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, borderRadius: 8, fontSize: 11 },
    labelStyle: { color: md3.onSurface },
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', background: md3.background }}>
      <Box sx={{ maxWidth: 1400, mx: 'auto', px: { xs: 2, md: 4 }, py: 3 }}>

        {/* ── Back + Header ── */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 3 }}>
          <IconButton onClick={() => navigate(-1)} size="small" sx={{ color: md3.onSurfaceVariant, mt: 0.5 }}>
            <ArrowBackIcon />
          </IconButton>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <RouterIcon sx={{ color, fontSize: 28 }} />
              <Typography variant="h5" sx={{ fontWeight: 800, color, lineHeight: 1.2 }}>
                {node.name || t('nodes.unnamed')}
              </Typography>
              <Chip label={node.role} size="small" sx={{ background: alpha(color, 0.15), color, fontWeight: 600 }} />
              {active
                ? <Chip label={`🟢 ${t('common.active')}`} size="small" sx={{ background: alpha('#22c55e', 0.12), color: '#22c55e' }} />
                : <Chip label={`⚪ ${t('common.stale')}`}  size="small" sx={{ background: alpha(md3.outline, 0.1),  color: md3.outline }} />}
              {node.batteryMv && <Chip label={`🔋 ${node.batteryMv} mV`} size="small" sx={{ background: alpha('#f59e0b', 0.12), color: '#f59e0b' }} />}
              {node.temperatureC && <Chip label={`🌡 ${node.temperatureC.toFixed(1)}°C`} size="small" sx={{ background: alpha(md3.secondary, 0.12), color: md3.secondary }} />}
            </Box>
            <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10, mt: 0.5, display: 'block', wordBreak: 'break-all' }}>
              {node.pubKey}
            </Typography>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, mt: 0.25, display: 'block' }}>
              {t('common.firstSeen')} {formatDistanceToNow(new Date(node.firstSeen), { addSuffix: true, locale: dateLocale })}
              {' · '}
              {t('common.lastSeen')} {formatDistanceToNow(new Date(node.lastSeen), { addSuffix: true, locale: dateLocale })}
            </Typography>
          </Box>
        </Box>

        {/* ── Stat cards ── */}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', sm: 'repeat(3,1fr)', md: 'repeat(6,1fr)' }, gap: 1.5, mb: 3 }}>
          <StatCard label={t('nodes.totalPkts')}  value={overview ? String(overview.totalPackets) : '…'} />
          <StatCard label={t('nodes.pktsToday')}  value={overview ? String(overview.packetsToday) : '…'} color={overview?.packetsToday ? '#22c55e' : undefined} />
          <StatCard label={t('common.adverts')}   value={String(node.advertCount)} />
          <StatCard label={t('nodes.avgHops')}    value={overview ? overview.avgHops.toFixed(1) : '…'} />
          <StatCard label={t('nodes.avgSnr')}     value={overview?.avgSnr != null ? `${overview.avgSnr.toFixed(1)} dB` : '—'}
            sub={rf?.snr?.length ? `${rf.snr.length} obs` : undefined} />
          <StatCard label="Avg RSSI"              value={rf?.rssi?.length ? `${(rf.rssi.reduce((a, b) => a + b, 0) / rf.rssi.length).toFixed(0)} dBm` : '—'}
            sub={rf?.rssi?.length ? `${rf.rssi.length} obs` : undefined} />
        </Box>

        {/* ── Row: activity + payload types ── */}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mb: 2 }}>

          {/* Activity timeline */}
          <Card>
            <SectionHeader icon={<Box sx={{ fontSize: 14 }}>📈</Box>} label="Activity — last 24 h" />
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={activityData} barSize={8}>
                <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} interval={3} />
                <YAxis hide allowDecimals={false} />
                <ReTooltip {...CHART_STYLE} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]} fill={color} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Payload type breakdown */}
          <Card>
            <SectionHeader icon={<Box sx={{ fontSize: 14 }}>📦</Box>} label="Payload types" />
            {typeData.length > 0 ? (
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                <ResponsiveContainer width={120} height={120}>
                  <PieChart>
                    <Pie data={typeData} dataKey="value" cx="50%" cy="50%" innerRadius={28} outerRadius={52}>
                      {typeData.map((_, i) => <Cell key={i} fill={`hsl(${(i * 57) % 360}, 60%, 55%)`} />)}
                    </Pie>
                    <ReTooltip {...CHART_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
                <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {typeData.map((d, i) => (
                    <Box key={d.name} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${(i * 57) % 360}, 60%, 55%)`, flexShrink: 0 }} />
                      <Typography variant="caption" sx={{ flex: 1, fontSize: 11 }}>{d.name}</Typography>
                      <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 11, fontWeight: 600 }}>{d.value}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            ) : (
              <Typography variant="caption" sx={{ color: md3.outline }}>No packets</Typography>
            )}
          </Card>
        </Box>

        {/* ── Row: SNR trend + RF distributions ── */}
        {rf && (rf.rssi ?? []).length > 0 && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' }, gap: 2, mb: 2 }}>

            {/* SNR over time */}
            {snrTrend.length > 1 && (
              <Card>
                <SectionHeader icon={<SignalCellularAltIcon sx={{ fontSize: 14 }} />} label="Signal quality trend" />
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={snrTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} interval={Math.floor(snrTrend.length / 6)} />
                    <YAxis yAxisId="left" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} width={28} />
                    {snrTrend[0]?.rssi != null && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} width={32} />}
                    <ReTooltip {...CHART_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="snr" dot={false} stroke={md3.primary} strokeWidth={2} name="SNR (dB)" yAxisId="left" />
                    {snrTrend[0]?.rssi != null && (
                      <Line type="monotone" dataKey="rssi" dot={false} stroke={md3.tertiary} strokeWidth={2} name="RSSI (dBm)" yAxisId="right" />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            )}

            {/* RF distributions */}
            <Card>
              <SectionHeader icon={<SignalCellularAltIcon sx={{ fontSize: 14 }} />} label={`RF — ${rf.rssi?.length ?? 0} obs`} />
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.5, fontSize: 10 }}>RSSI distribution</Typography>
              <ResponsiveContainer width="100%" height={80}>
                <BarChart data={rssiBuckets} barSize={10}>
                  <XAxis dataKey="label" tick={{ fontSize: 8, fill: md3.onSurfaceVariant }} />
                  <YAxis hide />
                  <ReTooltip {...CHART_STYLE} />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                    {rssiBuckets.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > -80 ? '#22c55e' : parseFloat(b.label) > -100 ? '#f59e0b' : md3.error} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mt: 1, mb: 0.5, fontSize: 10 }}>SNR distribution</Typography>
              <ResponsiveContainer width="100%" height={80}>
                <BarChart data={snrBuckets} barSize={10}>
                  <XAxis dataKey="label" tick={{ fontSize: 8, fill: md3.onSurfaceVariant }} />
                  <YAxis hide />
                  <ReTooltip {...CHART_STYLE} />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                    {snrBuckets.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > 6 ? '#22c55e' : parseFloat(b.label) > 0 ? '#f59e0b' : md3.error} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Box>
        )}

        {/* ── Row: heard by + map ── */}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: overview?.heardBy?.length ? '1fr 1fr' : '1fr' }, gap: 2, mb: 2 }}>

          {/* Heard by observers */}
          {overview?.heardBy && overview.heardBy.length > 0 && (
            <Card>
              <SectionHeader icon={<Box sx={{ fontSize: 14 }}>👁</Box>} label={t('nodes.heardBy', { count: overview.heardBy.length })} />
              {/* Observer SNR bar chart */}
              <ResponsiveContainer width="100%" height={Math.min(overview.heardBy.length * 32, 200)}>
                <BarChart data={overview.heardBy.slice(0, 8).map(o => ({
                  name: (o.observerName || o.observerId.slice(0, 10)) + (o.observerIata ? ` · ${o.observerIata}` : ''),
                  pkts: o.count,
                  snr: o.avgSnr != null ? parseFloat(o.avgSnr.toFixed(1)) : null,
                  rssi: o.avgRssi != null ? parseFloat(o.avgRssi.toFixed(0)) : null,
                }))} layout="vertical" barSize={12}>
                  <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} width={100} />
                  <ReTooltip {...CHART_STYLE} />
                  <Bar dataKey="pkts" name="Packets" radius={[0, 3, 3, 0]} fill={color} />
                </BarChart>
              </ResponsiveContainer>
              <Divider sx={{ my: 1.5 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                {overview.heardBy.map(o => (
                  <Box key={o.observerId} onClick={() => navigate(`/observers?id=${o.observerId}`)}
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderRadius: 2, cursor: 'pointer', '&:hover': { background: alpha(md3.primary, 0.06) } }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="caption" sx={{ fontWeight: 600, fontSize: 11 }}>
                        {o.observerName || o.observerId.slice(0, 16)}
                        {o.observerIata && <Box component="span" sx={{ ml: 0.5, color: md3.tertiary }}>{o.observerIata}</Box>}
                      </Typography>
                      <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, display: 'block' }}>
                        {o.count} pkts
                        {o.avgSnr  != null && ` · SNR ${o.avgSnr.toFixed(1)} dB`}
                        {o.avgRssi != null && ` · RSSI ${o.avgRssi.toFixed(0)} dBm`}
                      </Typography>
                    </Box>
                    <Typography variant="caption" sx={{ color: '#22c55e', fontSize: 10 }}>→</Typography>
                  </Box>
                ))}
              </Box>
            </Card>
          )}

          {/* Mini map */}
          {node.lat != null && node.lon != null && (
            <Card sx={{ minHeight: 260, display: 'flex', flexDirection: 'column' }}>
              <SectionHeader icon={<Box sx={{ fontSize: 14 }}>📍</Box>} label={`${node.lat.toFixed(5)}, ${node.lon?.toFixed(5)}`} />
              <Box sx={{ flex: 1, minHeight: 200 }}>
                <NodeMiniMap lat={node.lat} lon={node.lon} color={color} />
              </Box>
            </Card>
          )}
        </Box>

        {/* ── Recent packets ── */}
        {allPackets.length > 0 && (
          <Card>
            <SectionHeader icon={<Box sx={{ fontSize: 14 }}>📡</Box>} label={t('nodes.recentPackets', { count: allPackets.length })} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {allPackets.map(p => (
                <Box key={p.id} onClick={() => navigate(`/packets?hash=${p.hash}`)} sx={{
                  display: 'flex', alignItems: 'center', gap: 1.5,
                  px: 1.25, py: 0.75, borderRadius: 2, cursor: 'pointer',
                  '&:hover': { background: alpha(md3.primary, 0.06) },
                }}>
                  <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, flexShrink: 0, minWidth: 80 }}>
                    {formatDistanceToNow(new Date(p.firstSeen), { addSuffix: true, locale: dateLocale })}
                  </Typography>
                  <Chip label={PAYLOAD_NAMES[p.payloadType] ?? p.payloadType} size="small"
                    sx={{ fontSize: 10, height: 18, background: alpha(PAYLOAD_COLORS[p.payloadType] ?? md3.primary, 0.15), color: PAYLOAD_COLORS[p.payloadType] ?? md3.primary }} />
                  {p.obsCount > 0 && (
                    <Typography variant="caption" sx={{ color: md3.tertiary, fontSize: 10 }}>👁 {p.obsCount}</Typography>
                  )}
                  {p.maxHops > 0 && (
                    <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>{p.maxHops} hops</Typography>
                  )}
                  {p.bestObserver && (
                    <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      via {p.bestObserver}
                      {p.bestSnr  != null && ` · SNR ${p.bestSnr.toFixed(1)} dB`}
                      {p.bestRssi != null && ` · ${p.bestRssi.toFixed(0)} dBm`}
                    </Typography>
                  )}
                  <Tooltip title="View packet">
                    <OpenInNewIcon sx={{ fontSize: 13, color: md3.outline, ml: 'auto', flexShrink: 0 }} />
                  </Tooltip>
                </Box>
              ))}
            </Box>
          </Card>
        )}

      </Box>
    </Box>
  )
}
