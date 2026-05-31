import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import useMediaQuery from '@mui/material/useMediaQuery'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Divider from '@mui/material/Divider'
import { alpha, useTheme, type SxProps, type Theme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import CloseIcon from '@mui/icons-material/Close'
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import { formatDistanceToNow } from 'date-fns'
import type { Node, NodeOverview, RFStats } from '../types'
import { PAYLOAD_NAMES } from '../types'
import L from 'leaflet'

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
    L.circleMarker([lat, lon], { radius: 7, color: '#fff', fillColor: color, fillOpacity: 1, weight: 2.5 }).addTo(map)
    return () => { map.remove() }
  }, [lat, lon, color])

  return <div ref={divRef} style={{ height: 140, borderRadius: 8, overflow: 'hidden', marginBottom: 12 }} />
}

function isActive(n: Node) {
  const ms = (n.role === 'repeater' || n.role === 'room') ? 72 * 3600e3 : 24 * 3600e3
  return Date.now() - new Date(n.lastSeen).getTime() < ms
}

function bucketize(vals: number[], min: number, max: number, buckets: number) {
  const size = (max - min) / buckets
  const counts = Array(buckets).fill(0)
  for (const v of vals) counts[Math.min(buckets - 1, Math.max(0, Math.floor((v - min) / size)))]++
  return counts.map((count, i) => ({ label: `${(min + i * size).toFixed(0)}`, count }))
}

interface NodeDetailPanelProps {
  selected: Node
  overview: NodeOverview | null
  rf: RFStats | null
  /** Omit to render as a full page (no close button shown). */
  onClose?: () => void
  paperSx?: SxProps<Theme>
}

export default function NodeDetailPanel({ selected, overview, rf, onClose, paperSx }: NodeDetailPanelProps) {
  const theme = useTheme()
  const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))

  const roleColor = (role: string) => ({
    repeater: md3.primary, companion: md3.tertiary, room: '#22c55e',
    sensor: '#f59e0b', none: md3.outline,
  }[role] ?? md3.outline)

  const snrBuckets  = rf?.snr?.length  ? bucketize(rf.snr,  -25, 15,   8) : []
  const rssiBuckets = rf?.rssi?.length ? bucketize(rf.rssi, -120, -40, 8) : []

  const mobileSx: SxProps<Theme> = {
    position: 'fixed',
    top: 52, left: 0, right: 0, bottom: 56,
    zIndex: 1200,
    width: '100%',
    borderRadius: 0,
    overflow: 'auto',
    background: md3.surfaceContainerLow,
  }

  const desktopSx: SxProps<Theme> = {
    width: 460,
    borderLeft: `1px solid ${md3.outlineVariant}`,
    overflow: 'auto',
    flexShrink: 0,
    background: md3.surfaceContainerLow,
    borderRadius: 0,
    ...(paperSx as object),
  }

  return (
    <Paper elevation={2} sx={isMobile ? mobileSx : desktopSx}>
      {/* Header */}
      <Box sx={{ p: 2, borderBottom: `1px solid ${md3.outlineVariant}` }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.75 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: roleColor(selected.role), lineHeight: 1.2 }}>
              {selected.name || t('nodes.unnamed')}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25 }}>
              {isActive(selected)
                ? <Typography variant="caption" sx={{ color: '#22c55e', fontWeight: 600 }}>🟢 {t('common.active')}</Typography>
                : <Typography variant="caption" sx={{ color: md3.outline, fontWeight: 600 }}>⚪ {t('common.stale')}</Typography>}
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>
                — {t('common.lastSeen')} {formatDistanceToNow(new Date(selected.lastSeen), { addSuffix: true })}
              </Typography>
            </Box>
            <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 9, display: 'block', mt: 0.5 }}>
              {selected.pubKey}
            </Typography>
          </Box>
          {onClose && (
            <IconButton size="small" onClick={onClose} sx={{ alignSelf: 'flex-start', color: md3.onSurfaceVariant, ml: 1 }}>
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
          <Chip label={selected.role} size="small" sx={{ background: alpha(roleColor(selected.role), 0.2), color: roleColor(selected.role) }} />
          {selected.batteryMv && <Chip label={`🔋 ${selected.batteryMv} mV`} size="small" sx={{ background: alpha('#f59e0b', 0.15), color: '#f59e0b' }} />}
          {selected.temperatureC && <Chip label={`🌡 ${selected.temperatureC.toFixed(1)}°C`} size="small" sx={{ background: alpha(md3.secondary, 0.15), color: md3.secondary }} />}
        </Box>
      </Box>

      <Box sx={{ p: 2 }}>
        {/* Stats grid */}
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, mb: 2 }}>
          {[
            { l: t('common.lastSeen'),  v: formatDistanceToNow(new Date(selected.lastSeen),  { addSuffix: true }) },
            { l: t('common.firstSeen'), v: formatDistanceToNow(new Date(selected.firstSeen), { addSuffix: true }) },
            { l: t('common.adverts'),   v: String(selected.advertCount) },
            { l: t('nodes.totalPkts'),  v: overview ? String(overview.totalPackets) : '…' },
            { l: t('nodes.pktsToday'),  v: overview ? String(overview.packetsToday) : '…' },
            { l: t('nodes.avgHops'),    v: overview ? overview.avgHops.toFixed(1) : '…' },
            ...(overview?.avgSnr != null ? [{ l: t('nodes.avgSnr'), v: `${overview.avgSnr.toFixed(1)} dB` }] : []),
            ...(selected.lat != null ? [{ l: t('common.location'), v: `${selected.lat.toFixed(4)}, ${selected.lon?.toFixed(4)}` }] : []),
          ].map(({ l, v }) => (
            <Box key={l} sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, px: 1.25, py: 0.75 }}>
              <Typography variant="caption" sx={{ color: md3.outline, display: 'block', fontSize: 10 }}>{l}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>{v}</Typography>
            </Box>
          ))}
        </Box>

        {/* Mini map */}
        {selected.lat != null && selected.lon != null && (
          <NodeMiniMap lat={selected.lat} lon={selected.lon} color={roleColor(selected.role)} />
        )}

        {/* Recent packets */}
        {overview && overview.recentPackets.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
              {t('nodes.recentPackets', { count: overview.recentPackets.length })}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {overview.recentPackets.map(p => (
                <Box key={p.id} onClick={() => navigate(`/packets?hash=${p.hash}`)} sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  background: md3.surfaceContainerHighest, borderRadius: 2, px: 1.25, py: 0.75,
                  cursor: 'pointer',
                  '&:hover': { background: alpha(md3.primary, 0.08) },
                }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
                      <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, flexShrink: 0 }}>
                        {formatDistanceToNow(new Date(p.firstSeen), { addSuffix: true })}
                      </Typography>
                      <Typography variant="caption" sx={{ color: md3.primary, fontWeight: 600, fontSize: 11 }}>
                        📡 {PAYLOAD_NAMES[p.payloadType] ?? p.payloadType}
                      </Typography>
                      {p.obsCount > 0 && (
                        <Typography variant="caption" sx={{ color: md3.tertiary, fontSize: 10 }}>👁 {p.obsCount}</Typography>
                      )}
                    </Box>
                    {p.bestObserver && (
                      <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10 }}>
                        via {p.bestObserver}
                        {p.bestSnr != null && ` · SNR ${p.bestSnr.toFixed(1)}dB`}
                        {p.bestRssi != null && ` · RSSI ${p.bestRssi.toFixed(0)}dBm`}
                      </Typography>
                    )}
                  </Box>
                  <Typography variant="caption" sx={{ color: md3.primary, fontSize: 10, flexShrink: 0, fontWeight: 600 }}>
                    {t('nodes.analyze')}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {/* Heard by */}
        {overview && overview.heardBy.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
              {t('nodes.heardBy', { count: overview.heardBy.length })}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {overview.heardBy.map(o => (
                <Box key={o.observerId} onClick={() => navigate(`/observers?id=${o.observerId}`)} sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  background: md3.surfaceContainerHighest, borderRadius: 2, px: 1.25, py: 0.75,
                  cursor: 'pointer',
                  '&:hover': { background: alpha('#22c55e', 0.08) },
                }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, fontSize: 11, display: 'block' }}>
                      {o.observerName || o.observerId.slice(0, 16)}
                      {o.observerIata && <Box component="span" sx={{ ml: 0.5, color: md3.tertiary }}>{o.observerIata}</Box>}
                    </Typography>
                    <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>
                      {o.count} pkts
                      {o.avgSnr  != null && ` · SNR ${o.avgSnr.toFixed(1)}dB`}
                      {o.avgRssi != null && ` · RSSI ${o.avgRssi.toFixed(0)}`}
                    </Typography>
                  </Box>
                  <Typography variant="caption" sx={{ color: '#22c55e', fontSize: 10, flexShrink: 0 }}>→</Typography>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {/* RF Charts */}
        {rf && (rf.rssi ?? []).length > 0 && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
              <SignalCellularAltIcon sx={{ fontSize: 14, color: md3.primary }} />
              <Typography variant="overline" sx={{ color: md3.onSurfaceVariant }}>
                RF ({(rf.rssi ?? []).length} {t('packets.obs').toLowerCase()})
              </Typography>
            </Box>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.5 }}>{t('analytics.rssiDistribution')}</Typography>
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={rssiBuckets}>
                <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} />
                <YAxis hide />
                <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} />
                <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                  {rssiBuckets.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > -80 ? '#22c55e' : parseFloat(b.label) > -100 ? '#f59e0b' : md3.error} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mt: 1, mb: 0.5 }}>{t('analytics.snrDistribution')}</Typography>
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={snrBuckets}>
                <CartesianGrid strokeDasharray="3 3" stroke={alpha(md3.outlineVariant, 0.5)} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: md3.onSurfaceVariant }} />
                <YAxis hide />
                <Tooltip contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, fontSize: 11 }} />
                <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                  {snrBuckets.map((b, i) => <Cell key={i} fill={parseFloat(b.label) > 6 ? '#22c55e' : parseFloat(b.label) > 0 ? '#f59e0b' : md3.error} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
        {rf && (rf.rssi ?? []).length === 0 && (
          <Typography variant="caption" sx={{ color: md3.outline, display: 'block', mt: 2 }}>{t('nodes.noRf')}</Typography>
        )}
      </Box>
    </Paper>
  )
}
