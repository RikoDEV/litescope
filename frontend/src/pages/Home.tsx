import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import CardActionArea from '@mui/material/CardActionArea'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import RouterIcon from '@mui/icons-material/Router'
import WifiIcon from '@mui/icons-material/Wifi'
import MapIcon from '@mui/icons-material/Map'
import ForumIcon from '@mui/icons-material/Forum'
import BarChartIcon from '@mui/icons-material/BarChart'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import FavoriteIcon from '@mui/icons-material/Favorite'
import HistoryIcon from '@mui/icons-material/History'
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents'
import { AreaChart, Area, Tooltip as RTooltip, ResponsiveContainer } from 'recharts'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Node, Observer, OverviewStats, Packet } from '../types'
import { PAYLOAD_NAMES, PAYLOAD_COLORS, PAYLOAD_ICONS } from '../types'
import { formatDistanceToNow } from 'date-fns'
import { useDateLocale } from '../hooks/useDateLocale'
import { IataFlag } from '../utils/flags'
import { ROLE_GLYPH, roleColor } from '../utils/roles'

// ── component ─────────────────────────────────────────────────────────────────
export default function Home() {
  const theme    = useTheme()
  const md3      = theme.palette.md3
  const navigate = useNavigate()
  const { t }    = useTranslation()
  const dateLocale = useDateLocale()

  // data
  const [stats,     setStats]     = useState<OverviewStats | null>(null)
  const [activity,  setActivity]  = useState<Array<{ hour: string; label: string; count: number }>>([])
  const [topNodes,  setTopNodes]  = useState<Node[]>([])
  const [topSort,   setTopSort]   = useState<'adverts' | 'retransmits'>('adverts')
  const [observers, setObservers] = useState<Observer[]>([])
  const [recent,    setRecent]    = useState<Packet[]>([])
  const [rf,        setRF]        = useState<{ snrSummary: { avg: number }; rssiSummary: { avg: number }; totalObservations: number } | null>(null)
  const [pktRate,   setPktRate]   = useState(0)

  // live rate counter
  const rateWindow = useRef<number[]>([])
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      rateWindow.current = rateWindow.current.filter(t => now - t < 60_000)
      setPktRate(rateWindow.current.length)
    }, 2000)
    return () => clearInterval(id)
  }, [])

  // initial data load — all in parallel
  useEffect(() => {
    api.overview().then(s => {
      setStats(s)
      // Seed the live rate window from the backend's actual last-minute count so
      // the figure is correct on load instead of climbing from 0. Synthetic
      // timestamps are spread across the past minute and expire naturally as the
      // live stream takes over.
      if (s && rateWindow.current.length === 0 && s.packetRate > 0) {
        const now = Date.now()
        for (let i = 0; i < s.packetRate; i++) {
          rateWindow.current.push(now - Math.floor((i / s.packetRate) * 60_000))
        }
        setPktRate(s.packetRate)
      }
    })
    api.analyticsActivity(24).then(d => setActivity(d ?? []))
    api.observers().then(r => setObservers(r.observers ?? []))
    api.packets(6, 0).then(r => setRecent(r.packets ?? []))
    api.analyticsRF().then(d => d && setRF({ snrSummary: d.snrSummary, rssiSummary: d.rssiSummary, totalObservations: d.totalObservations }))
  }, [])

  // top nodes — refetch when the ranking metric changes. Guard against stale
  // responses: this endpoint is slow (it computes retransmit counts), so the
  // mount request and a quick toggle can resolve out of order — without this the
  // older response could overwrite the list with the wrong ranking.
  useEffect(() => {
    let cancelled = false
    api.analyticsNodesTop(6, topSort).then(d => { if (!cancelled) setTopNodes(d ?? []) })
    return () => { cancelled = true }
  }, [topSort])

  // live packet stream
  useEffect(() => {
    return stream.subscribe(msg => {
      if (msg.type !== 'packet') return
      rateWindow.current.push(Date.now())
      setRecent(prev => [msg.data, ...prev.slice(0, 5)])
      setStats(s => s ? { ...s, totalPackets: s.totalPackets + 1 } : s)
    })
  }, [])

  // derived
  const activeObservers = observers.filter(o => Date.now() - new Date(o.lastSeen).getTime() < 5 * 60_000)
  const activityPeak    = activity.reduce((m, b) => b.count > m ? b.count : m, 0)
  const activityTotal   = activity.reduce((s, b) => s + b.count, 0)
  const isActive = (n: Node) => Date.now() - new Date(n.lastSeen).getTime() < 24 * 3600_000

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <Box sx={{ height: '100%', overflowY: 'auto', background: md3.background }}>

      {/* ── Hero ── */}
      <Box sx={{
        position: 'relative', overflow: 'hidden',
        px: { xs: 2, sm: 3, md: 4 }, pt: { xs: 2.5, md: 3 }, pb: 2.5,
        background: `linear-gradient(135deg, ${alpha(md3.primaryContainer, 0.35)} 0%, ${alpha(md3.tertiaryContainer, 0.25)} 50%, ${md3.background} 100%)`,
        borderBottom: `1px solid ${md3.outlineVariant}`,
      }}>
        {/* Decorative blobs */}
        <Box sx={{ position: 'absolute', top: -50, right: -50, width: 180, height: 180, borderRadius: '50%', background: alpha(md3.primary, 0.07), pointerEvents: 'none' }} />
        <Box sx={{ position: 'absolute', bottom: -30, left: '35%', width: 130, height: 130, borderRadius: '50%', background: alpha(md3.tertiary, 0.06), pointerEvents: 'none' }} />

        {/* Title row — icon + name only, always one line */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
          <Box component="img" src="/icon.svg" alt="liteScope" sx={{ width: 40, height: 40, flexShrink: 0, borderRadius: '12px', boxShadow: `0 3px 12px ${alpha(md3.primary, 0.4)}` }} />
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.1, color: md3.onSurface }}>liteScope</Typography>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('home.subtitle')}</Typography>
          </Box>
        </Box>


        {/* Stat cards — compact */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 1 }}>
          {[
            { label: t('home.totalPackets'), value: stats?.totalPackets ?? '—',    color: md3.primary,   suffix: '' },
            { label: t('home.nodes'),        value: stats?.totalNodes ?? '—',      color: md3.tertiary,  suffix: '' },
            { label: t('home.observers'),    value: stats?.totalObservers ?? '—',  color: '#22c55e',     suffix: '' },
            { label: t('home.observations'), value: rf?.totalObservations ?? '—',  color: '#f59e0b',     suffix: '' },
            { label: t('home.avgSnr'),       value: rf ? rf.snrSummary.avg.toFixed(1) : '—', color: '#14b8a6', suffix: ' dB' },
            { label: t('home.avgRssi'),      value: rf ? rf.rssiSummary.avg.toFixed(0) : '—', color: '#ec4899', suffix: ' dBm' },
          ].map(c => (
            <Box key={c.label} sx={{
              px: 1.25, py: 0.875, borderRadius: 2,
              background: alpha(c.color, 0.08),
              border: `1px solid ${alpha(c.color, 0.18)}`,
              backdropFilter: 'blur(8px)',
            }}>
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', fontSize: 10, mb: 0.15, lineHeight: 1.3 }}>
                {c.label}
              </Typography>
              <Typography sx={{ fontSize: 20, fontWeight: 800, color: c.color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                {typeof c.value === 'number' ? c.value.toLocaleString() : c.value}
                <Box component="span" sx={{ fontSize: 11, fontWeight: 500, ml: 0.2 }}>{c.suffix}</Box>
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* ── Body grid ── */}
      <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 2.5 }}>

        {/* Row 1: Activity chart + Network health */}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 280px' }, gap: 2.5 }}>

          {/* 24h Activity */}
          <Card sx={{ display: 'flex', flexDirection: 'column' }}>
            <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5, flexShrink: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <SectionIcon Icon={ShowChartIcon} color={md3.primary} />
                  <Box>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t('home.activity24h')}</Typography>
                    <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('home.packetsPerHour')}</Typography>
                  </Box>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block' }}>
                    {t('home.peak')}: <Box component="span" sx={{ color: md3.primary, fontWeight: 700 }}>{activityPeak}</Box>
                  </Typography>
                  <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>
                    {t('home.total')}: <Box component="span" sx={{ color: md3.primary, fontWeight: 700 }}>{activityTotal.toLocaleString()}</Box>
                  </Typography>
                </Box>
              </Box>
              <Box sx={{ flex: 1, minHeight: 80 }}>
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={80}>
                <AreaChart data={activity} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="homeActGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={md3.primary} stopOpacity={0.45} />
                      <stop offset="95%" stopColor={md3.primary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <RTooltip
                    contentStyle={{ background: md3.surfaceContainerHigh, border: `1px solid ${md3.outlineVariant}`, borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ''}
                  />
                  <Area type="monotone" dataKey="count" stroke={md3.primary} strokeWidth={2} fill="url(#homeActGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
              </Box>
            </CardContent>
          </Card>

          {/* Network health */}
          <Card>
            <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <SectionIcon Icon={FavoriteIcon} color="#22c55e" />
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t('home.networkHealth')}</Typography>
              </Box>

              <HealthRow
                label={t('home.observersOnline')}
                value={`${activeObservers.length} / ${observers.length}`}
                color={activeObservers.length > 0 ? '#22c55e' : md3.error}
                bar={observers.length > 0 ? activeObservers.length / observers.length : 0}
              />
              <HealthRow
                label={t('home.avgSnr')}
                value={rf ? `${rf.snrSummary.avg.toFixed(1)} dB` : '—'}
                color={rf && rf.snrSummary.avg > 5 ? '#22c55e' : rf && rf.snrSummary.avg > 0 ? '#f59e0b' : md3.error}
                bar={rf ? Math.min(1, (rf.snrSummary.avg + 20) / 35) : 0}
              />
              <HealthRow
                label={t('home.avgRssi')}
                value={rf ? `${rf.rssiSummary.avg.toFixed(0)} dBm` : '—'}
                color={rf && rf.rssiSummary.avg > -80 ? '#22c55e' : rf && rf.rssiSummary.avg > -100 ? '#f59e0b' : md3.error}
                bar={rf ? Math.min(1, (rf.rssiSummary.avg + 130) / 90) : 0}
              />
              <HealthRow
                label={t('home.packetRate')}
                value={`${pktRate}/min`}
                color={pktRate > 0 ? md3.primary : md3.outline}
                bar={Math.min(1, pktRate / 60)}
              />

              <Box sx={{ flex: 1 }} />
              <Divider sx={{ my: 1.5 }} />
              {/* Observer chips */}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {observers.slice(0, 6).map(o => {
                  const on = Date.now() - new Date(o.lastSeen).getTime() < 5 * 60_000
                  return (
                    <Tooltip key={o.id} title={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={o.iata} size={12} />{o.iata ?? '—'} · {on ? t('common.online') : t('common.offline')}</Box>}>
                      <Chip
                        label={o.name || o.id.slice(0, 8)}
                        size="small"
                        icon={<Box sx={{ width: 6, height: 6, borderRadius: '50%', background: on ? '#22c55e' : md3.outline, ml: 0.5, flexShrink: 0 }} />}
                        sx={{
                          fontSize: 11, height: 22,
                          background: alpha(on ? '#22c55e' : md3.outline, 0.1),
                          color: on ? '#22c55e' : md3.onSurfaceVariant,
                          border: `1px solid ${alpha(on ? '#22c55e' : md3.outline, 0.3)}`,
                        }}
                      />
                    </Tooltip>
                  )
                })}
                {observers.length > 6 && (
                  <Chip label={`+${observers.length - 6}`} size="small" sx={{ fontSize: 11, height: 22, color: md3.outline }} />
                )}
              </Box>
            </CardContent>
          </Card>
        </Box>

        {/* Row 2: Recent packets + Top nodes */}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2.5 }}>

          {/* Recent packets */}
          <Card>
            <Box onClick={() => navigate('/packets')} sx={{ px: 2, pt: 2, pb: 0.5, cursor: 'pointer', '&:hover .viewAll': { opacity: 1 } }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <SectionIcon Icon={HistoryIcon} color={md3.tertiary} />
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t('home.recentPackets')}</Typography>
                </Box>
                <Typography className="viewAll" variant="caption" sx={{ color: md3.primary }}>{t('common.viewAll')} →</Typography>
              </Box>
            </Box>
            <Box sx={{ px: 2, pb: 1.5 }}>
              {recent.length === 0 && (
                <Typography variant="body2" sx={{ color: md3.outline, py: 2, textAlign: 'center' }}>
                  {t('home.noPackets')}
                </Typography>
              )}
              {recent.map((p, i) => {
                const dec   = p.decoded
                const color = PAYLOAD_COLORS[p.payloadType] ?? md3.outline
                const icon  = PAYLOAD_ICONS[p.payloadType] ?? '·'
                const label = (dec?.name ?? dec?.sender ?? dec?.channel) as string | undefined
                return (
                  <Box key={p.id} onClick={() => navigate(`/packets?hash=${p.hash}`)} sx={{
                    display: 'flex', alignItems: 'center', gap: 1.25, py: 0.65, cursor: 'pointer',
                    borderBottom: i < recent.length - 1 ? `1px solid ${alpha(md3.outlineVariant, 0.4)}` : 'none',
                    '&:hover': { background: alpha(md3.primary, 0.04), mx: -2, px: 2, borderRadius: 1 },
                  }}>
                    <Box sx={{
                      width: 28, height: 28, borderRadius: 2, flexShrink: 0,
                      background: alpha(color, 0.12),
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14,
                    }}>{icon}</Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Typography variant="caption" sx={{ color, fontWeight: 700 }}>
                          {PAYLOAD_NAMES[p.payloadType] ?? p.payloadType}
                        </Typography>
                        {label && (
                          <Typography variant="caption" sx={{ color: md3.onSurface, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {label}
                          </Typography>
                        )}
                      </Box>
                      <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10 }}>
                        {p.hash}
                      </Typography>
                    </Box>
                    <Typography variant="caption" sx={{ color: md3.outline, flexShrink: 0, fontSize: 10 }}>
                      {formatDistanceToNow(new Date(p.firstSeen), { addSuffix: true, locale: dateLocale })}
                    </Typography>
                  </Box>
                )
              })}
            </Box>
          </Card>

          {/* Top nodes */}
          <Card>
            <Box sx={{ px: 2, pt: 2, pb: 0.5 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.25 }}>
                <Box onClick={() => navigate('/nodes')} sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer' }}>
                  <SectionIcon Icon={EmojiEventsIcon} color="#f59e0b" />
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t('home.topNodes')}</Typography>
                </Box>
                <Typography onClick={() => navigate('/nodes')} variant="caption" sx={{ color: md3.primary, cursor: 'pointer' }}>{t('common.viewAll')} →</Typography>
              </Box>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={topSort}
                onChange={(_, v) => v && setTopSort(v)}
                sx={{ mb: 0.5, '& .MuiToggleButton-root': { py: 0.25, px: 1, fontSize: 11, textTransform: 'none', lineHeight: 1.4 } }}
              >
                <ToggleButton value="adverts">{t('common.adverts')}</ToggleButton>
                <ToggleButton value="retransmits">{t('common.retransmits')}</ToggleButton>
              </ToggleButtonGroup>
            </Box>
            <Box sx={{ px: 2, pb: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {topNodes.length === 0 && (
                <Typography variant="body2" sx={{ color: md3.outline, py: 2, textAlign: 'center' }}>{t('home.noNodes')}</Typography>
              )}
              {topNodes.map((n, i) => {
                const color  = roleColor(n.role, md3)
                const active = isActive(n)
                return (
                  <Box key={n.pubKey} onClick={() => navigate(`/nodes/${n.pubKey}`)} sx={{
                    display: 'flex', alignItems: 'center', gap: 1.25, py: 0.5, cursor: 'pointer',
                    borderBottom: i < topNodes.length - 1 ? `1px solid ${alpha(md3.outlineVariant, 0.4)}` : 'none',
                    '&:hover': { background: alpha(md3.primary, 0.04), mx: -2, px: 2, borderRadius: 1 },
                  }}>
                    {/* Rank + role shape */}
                    <Box sx={{
                      width: 28, height: 28, borderRadius: 2, flexShrink: 0,
                      background: alpha(color, 0.12),
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Typography sx={{ fontSize: 14, color, lineHeight: 1 }}>
                        {ROLE_GLYPH[n.role] ?? '●'}
                      </Typography>
                    </Box>

                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {n.name || n.pubKey.slice(0, 10) + '…'}
                        </Typography>
                        <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: active ? '#22c55e' : md3.outline, flexShrink: 0 }} />
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Chip label={n.role} size="small" sx={{ fontSize: 10, height: 16, background: alpha(color, 0.15), color, border: 'none', px: 0 }} />
                        {n.lat != null && (
                          <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>
                            {n.lat.toFixed(2)}, {n.lon?.toFixed(2)}
                          </Typography>
                        )}
                      </Box>
                    </Box>

                    {/* Ranking metric badge */}
                    <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                      <Typography sx={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1 }}>
                        {topSort === 'retransmits' ? (n.retransmitCount ?? 0) : n.advertCount}
                      </Typography>
                      <Typography variant="caption" sx={{ color: md3.outline, fontSize: 9 }}>
                        {(topSort === 'retransmits' ? t('common.retransmits') : t('common.adverts')).toLowerCase()}
                      </Typography>
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Card>
        </Box>

        {/* Row 3: Quick nav cards */}
        <Box>
          <Typography variant="overline" sx={{ color: md3.outline, px: 0.5, display: 'block', mb: 1 }}>
            {t('home.quickAccess')}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.5 }}>
            {[
              { label: t('nav.map'),       sub: t('home.mapSub'),                              Icon: MapIcon,      to: '/map',       color: md3.tertiary },
              { label: t('nav.channels'),  sub: t('home.channelsSub'),                         Icon: ForumIcon,    to: '/channels',  color: '#ec4899'   },
              { label: t('nav.nodes'),     sub: t('home.discovered', { count: stats?.totalNodes ?? 0 }),  Icon: RouterIcon,   to: '/nodes',     color: md3.primary },
              { label: t('nav.observers'), sub: t('home.onlineCount', { count: activeObservers.length }),  Icon: WifiIcon,     to: '/observers', color: '#22c55e'   },
              { label: t('nav.analytics'), sub: t('home.analyticsSub'),                        Icon: BarChartIcon, to: '/analytics', color: '#f59e0b'  },
            ].map(({ label, sub, Icon, to, color }) => (
              <Card key={to} sx={{
                border: `1px solid ${alpha(color, 0.25)}`,
                transition: 'transform 0.18s cubic-bezier(0.2,0,0,1), box-shadow 0.18s',
                '&:hover': { transform: 'translateY(-2px)', boxShadow: `0 8px 24px ${alpha(color, 0.2)}` },
              }}>
                <CardActionArea onClick={() => navigate(to)} sx={{ p: 2 }}>
                  <Box sx={{
                    width: 40, height: 40, borderRadius: 2.5, mb: 1.25,
                    background: alpha(color, 0.15),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon sx={{ fontSize: 22, color }} />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 700, color: md3.onSurface }}>{label}</Typography>
                  <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{sub}</Typography>
                </CardActionArea>
              </Card>
            ))}
          </Box>
        </Box>

      </Box>
    </Box>
  )
}

// ── SectionIcon ────────────────────────────────────────────────────────────────
function SectionIcon({ Icon, color }: { Icon: typeof MapIcon; color: string }) {
  return (
    <Box sx={{ width: 28, height: 28, borderRadius: 2, flexShrink: 0, background: alpha(color, 0.15), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Icon sx={{ fontSize: 17, color }} />
    </Box>
  )
}

// ── HealthRow ──────────────────────────────────────────────────────────────────
function HealthRow({ label, value, color, bar }: { label: string; value: string; color: string; bar: number }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  return (
    <Box sx={{ mb: 1.25 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.4 }}>
        <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{label}</Typography>
        <Typography variant="caption" sx={{ color, fontWeight: 700 }}>{value}</Typography>
      </Box>
      <Box sx={{ height: 4, borderRadius: 2, background: alpha(md3.outlineVariant, 0.4) }}>
        <Box sx={{
          height: '100%', borderRadius: 2,
          width: `${Math.max(2, bar * 100)}%`,
          background: color,
          transition: 'width 0.6s cubic-bezier(0.2, 0, 0, 1)',
        }} />
      </Box>
    </Box>
  )
}
