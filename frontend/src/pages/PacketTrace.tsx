import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import CircularProgress from '@mui/material/CircularProgress'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import { api } from '../services/api'
import type { PacketDetail } from '../types'
import { PAYLOAD_NAMES, ROUTE_NAMES, PAYLOAD_COLORS } from '../types'
import { parseHops, deduplicateObs, relativeTime } from '../utils/packets'
import { IataFlag } from '../utils/flags'
import { formatDistanceToNow } from 'date-fns'

// ── helpers ───────────────────────────────────────────────────────────────────

function snrColor(v: number | null, error: string, tertiary: string) {
  if (v == null) return '#64748b'
  if (v > 5) return '#22c55e'
  if (v > 0) return '#f59e0b'
  return error
}

function rssiColor(v: number | null, error: string) {
  if (v == null) return '#64748b'
  if (v > -80) return '#22c55e'
  if (v > -100) return '#f59e0b'
  return error
}

// ── SVG Path Graph ────────────────────────────────────────────────────────────

interface PathRow {
  hops:     string[]
  observer: string
  obsId:    string
  obsCount: number
  snr:      number | null
  rssi:     number | null
  deltaMs:  number
}

// Trie node used for tree layout
interface TNode {
  id:       string
  label:    string
  sublabel: string
  type:     'source' | 'hop' | 'observer'
  color:    string
  snr:      number | null
  children: TNode[]
  // layout — assigned by layoutTree
  depth:    number
  x:        number
  y:        number
  leafCount: number
}

function buildTrie(rows: PathRow[], senderLabel: string, srcColor: string): TNode {
  const root: TNode = {
    id: '__src__', label: senderLabel.slice(0, 10), sublabel: 'source',
    type: 'source', color: srcColor, snr: null, children: [], depth: 0, x: 0, y: 0, leafCount: 0,
  }
  for (const row of rows) {
    let cur = root
    for (const hop of row.hops) {
      const id = `hop:${hop}`
      let child = cur.children.find(c => c.id === id)
      if (!child) {
        child = {
          id, label: hop.slice(0, 4).toUpperCase(), sublabel: 'relay',
          type: 'hop', color: '#818cf8', snr: null, children: [],
          depth: 0, x: 0, y: 0, leafCount: 0,
        }
        cur.children.push(child)
      }
      cur = child
    }
    const obsId = `obs:${row.obsId}`
    if (!cur.children.find(c => c.id === obsId)) {
      const good = (row.snr ?? -Infinity) > 5
      cur.children.push({
        id: obsId,
        label: (row.observer || row.obsId.slice(0, 8)).slice(0, 10),
        sublabel: row.snr != null ? `${row.snr.toFixed(0)} dB` : '',
        type: 'observer', color: good ? '#22c55e' : '#f59e0b', snr: row.snr,
        children: [], depth: 0, x: 0, y: 0, leafCount: 0,
      })
    }
  }
  return root
}

function assignLayout(node: TNode, depth: number, slotStart: number, slotH: number): number {
  node.depth = depth
  if (node.children.length === 0) {
    node.y = slotStart + slotH / 2
    node.leafCount = 1
    return slotStart + slotH
  }
  let next = slotStart
  let totalLeaves = 0
  let sumY = 0
  for (const child of node.children) {
    next = assignLayout(child, depth + 1, next, slotH)
    totalLeaves += child.leafCount
    sumY += child.y * child.leafCount
  }
  node.y = sumY / totalLeaves
  node.leafCount = totalLeaves
  return next
}

function collectAll(node: TNode, nodes: TNode[] = []): TNode[] {
  nodes.push(node)
  for (const c of node.children) collectAll(c, nodes)
  return nodes
}

function collectEdges(node: TNode, edges: [TNode, TNode][] = []): [TNode, TNode][] {
  for (const c of node.children) { edges.push([node, c]); collectEdges(c, edges) }
  return edges
}

function PathGraph({ pkt, rows }: { pkt: PacketDetail; rows: PathRow[] }) {
  const theme = useTheme(); const md3 = theme.palette.md3

  const srcColor   = PAYLOAD_COLORS[pkt.payloadType] ?? '#94a3b8'
  const senderName = (pkt.decoded?.name as string | undefined)
    || (pkt.decoded?.sender as string | undefined)
    || (pkt.decoded?.pubKey as string | undefined)?.slice(0, 8)
    || 'Source'

  const COL_W  = 150
  const SLOT_H = 64
  const PAD    = { x: 28, y: 32 }
  const R      = { source: 24, hop: 15, observer: 22 }

  const root = buildTrie(rows, senderName, srcColor)
  assignLayout(root, 0, PAD.y, SLOT_H)

  const allNodes = collectAll(root)
  const maxDepth = allNodes.reduce((m, n) => Math.max(m, n.depth), 0)
  allNodes.forEach(n => { n.x = PAD.x + R.source + n.depth * COL_W })

  const totalW = PAD.x * 2 + R.source + (maxDepth + 1) * COL_W
  const totalH = Math.max(PAD.y * 2 + root.leafCount * SLOT_H, 100)

  const nodeR = (n: TNode) => n.type === 'source' ? R.source : n.type === 'hop' ? R.hop : R.observer

  // Smooth S-curve between nodes
  const edgePath = (from: TNode, to: TNode) => {
    const x1 = from.x + nodeR(from)
    const y1 = from.y
    const x2 = to.x - nodeR(to)
    const y2 = to.y
    const dx  = (x2 - x1) * 0.55
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
  }

  const glowId = `glow-${pkt.hash.slice(0, 8)}`

  return (
    <Box sx={{ overflowX: 'auto', pb: 1 }}>
      <svg width={totalW} height={totalH} style={{ display: 'block', minWidth: totalW }}>
        <defs>
          <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Edges — drawn first so nodes sit on top */}
        {collectEdges(root).map(([from, to], i) => {
          const isToObs = to.type === 'observer'
          return (
            <path key={`e-${i}`}
              d={edgePath(from, to)}
              fill="none"
              stroke={isToObs ? alpha(to.color, 0.55) : alpha('#818cf8', 0.35)}
              strokeWidth={isToObs ? 2 : 1.5}
              strokeDasharray={to.type === 'hop' ? '5 3' : undefined}
            />
          )
        })}

        {/* Nodes */}
        {allNodes.map(n => {
          const r   = nodeR(n)
          const isObs = n.type === 'observer'
          const isSrc = n.type === 'source'
          return (
            <g key={n.id}>
              {/* Glow ring for source */}
              {isSrc && (
                <circle cx={n.x} cy={n.y} r={r + 6}
                  fill="none" stroke={alpha(n.color, 0.2)} strokeWidth={6} />
              )}
              {/* Main circle */}
              <circle cx={n.x} cy={n.y} r={r}
                fill={alpha(n.color, isSrc ? 0.2 : 0.12)}
                stroke={n.color}
                strokeWidth={isSrc ? 2.5 : isObs ? 2 : 1.5}
                strokeDasharray={n.type === 'hop' ? '4 2' : undefined}
                filter={isSrc ? `url(#${glowId})` : undefined}
              />
              {/* Label inside */}
              <text x={n.x} y={n.y - (n.sublabel ? 4 : 0)}
                textAnchor="middle" dominantBaseline="central"
                fontSize={isSrc ? 9 : 8} fontWeight={700}
                fill={n.color}
                fontFamily={n.type === 'hop' ? 'monospace' : undefined}>
                {n.label.slice(0, isSrc ? 10 : 8)}
              </text>
              {n.sublabel && (
                <text x={n.x} y={n.y + 8}
                  textAnchor="middle" dominantBaseline="central"
                  fontSize={7} fill={alpha(n.color, 0.7)}>
                  {n.sublabel}
                </text>
              )}
              {/* Sub-label below circle */}
              {isObs && (
                <text x={n.x} y={n.y + r + 11}
                  textAnchor="middle" fontSize={8} fill={md3.onSurfaceVariant}>
                  observer
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </Box>
  )
}

// ── Propagation Timeline ──────────────────────────────────────────────────────

function PropagationTimeline({ pkt }: { pkt: PacketDetail }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const obs = deduplicateObs(pkt.observations)
    .map(o => ({ ...o, ms: new Date(o.timestamp).getTime() }))
    .sort((a, b) => a.ms - b.ms)

  if (obs.length === 0) return null

  const t0   = obs[0].ms
  const tMax = obs[obs.length - 1].ms
  const span = tMax - t0 || 1

  return (
    <Box>
      {/* Timeline bar */}
      {obs.length > 1 && (
        <Box sx={{ position: 'relative', height: 32, mb: 3, mx: 1 }}>
          <Box sx={{
            position: 'absolute', top: '50%', left: 0, right: 0, height: 2,
            background: alpha(md3.outlineVariant, 0.5), borderRadius: 1,
          }} />
          {obs.map((o, i) => {
            const pct = ((o.ms - t0) / span) * 100
            const obsColor = snrColor(o.snr, md3.error, md3.tertiary)
            return (
              <Tooltip key={o.id} title={`${o.observerName || o.observerId.slice(0, 12)} · ${o.ms - t0}ms`}>
                <Box sx={{
                  position: 'absolute', top: '50%', left: `${pct}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 10, height: 10, borderRadius: '50%',
                  background: obsColor, border: `2px solid ${md3.surfaceContainerLow}`,
                  cursor: 'default', zIndex: i,
                }} />
              </Tooltip>
            )
          })}
          <Typography variant="caption" sx={{ position: 'absolute', bottom: -18, left: 0, color: md3.outline, fontSize: 10 }}>
            0 ms
          </Typography>
          <Typography variant="caption" sx={{ position: 'absolute', bottom: -18, right: 0, color: md3.outline, fontSize: 10 }}>
            +{span} ms
          </Typography>
        </Box>
      )}

      {/* Observation rows */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {obs.map((o, i) => {
          const delta = o.ms - t0
          const hops  = parseHops(o.pathJson)
          const obsColor = snrColor(o.snr, md3.error, md3.tertiary)
          return (
            <Box key={o.id} sx={{
              display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1,
              borderRadius: 2, background: alpha(obsColor, 0.06), border: `1px solid ${alpha(obsColor, 0.2)}`,
            }}>
              {/* Rank */}
              <Typography sx={{ fontSize: 11, color: md3.outline, minWidth: 20, textAlign: 'right' }}>
                {i + 1}
              </Typography>

              {/* Observer */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <IataFlag iata={o.observerIata} size={11} />
                  <Typography variant="caption" sx={{ fontWeight: 600, color: md3.onSurface }}>
                    {o.observerName || o.observerId.slice(0, 16)}
                  </Typography>
                  {o.observerIata && (
                    <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>
                      {o.observerIata}
                    </Typography>
                  )}
                </Box>
                {hops.length > 0 && (
                  <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10 }}>
                    {hops.join(' → ')}
                  </Typography>
                )}
              </Box>

              {/* Timing */}
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10, whiteSpace: 'nowrap' }}>
                {i === 0 ? 'first' : `+${delta} ms`}
              </Typography>

              {/* Signal */}
              <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                {o.snr != null && (
                  <Chip label={`${o.snr.toFixed(1)} dB`} size="small"
                    sx={{ fontSize: 10, height: 18, background: alpha(snrColor(o.snr, md3.error, md3.tertiary), 0.15), color: snrColor(o.snr, md3.error, md3.tertiary) }} />
                )}
                {o.rssi != null && (
                  <Chip label={`${o.rssi.toFixed(0)} dBm`} size="small"
                    sx={{ fontSize: 10, height: 18, background: alpha(rssiColor(o.rssi, md3.error), 0.12), color: rssiColor(o.rssi, md3.error) }} />
                )}
                {hops.length > 0 && (
                  <Chip label={`${hops.length} hop${hops.length > 1 ? 's' : ''}`} size="small"
                    sx={{ fontSize: 10, height: 18, background: alpha('#818cf8', 0.12), color: '#818cf8' }} />
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PacketTrace() {
  const { hash } = useParams<{ hash: string }>()
  const navigate  = useNavigate()
  const theme     = useTheme(); const md3 = theme.palette.md3
  const { t }     = useTranslation()

  const [pkt,     setPkt]     = useState<PacketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    if (!hash) return
    document.title = `Trace · ${hash.slice(0, 12)} — liteScope`
    api.packet(hash)
      .then(setPkt)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [hash])

  if (loading) return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <CircularProgress size={32} />
    </Box>
  )

  if (error || !pkt) return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
      <Typography sx={{ color: md3.onSurfaceVariant }}>Packet not found</Typography>
      <IconButton onClick={() => navigate(-1)}><ArrowBackIcon /></IconButton>
    </Box>
  )

  const obs    = deduplicateObs(pkt.observations)
  const sorted = [...obs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  const t0     = sorted.length ? new Date(sorted[0].timestamp).getTime() : 0
  const tLast  = sorted.length ? new Date(sorted[sorted.length - 1].timestamp).getTime() : 0
  const spreadMs = tLast - t0

  const uniqueObservers = new Set(obs.map(o => o.observerId)).size
  const payloadName = PAYLOAD_NAMES[pkt.payloadType] ?? String(pkt.payloadType)
  const routeName   = ROUTE_NAMES[pkt.routeType]   ?? String(pkt.routeType)
  const roleColor   = PAYLOAD_COLORS[pkt.payloadType] ?? '#94a3b8'

  // Build path rows for the graph (group by path + observer)
  const pathRows: PathRow[] = []
  const seen = new Map<string, number>()
  for (const o of sorted) {
    const hops = parseHops(o.pathJson)
    const key  = hops.join(',') + '|' + o.observerId
    if (!seen.has(key)) {
      seen.set(key, pathRows.length)
      pathRows.push({
        hops, observer: o.observerName, obsId: o.observerId,
        obsCount: 1, snr: o.snr, rssi: o.rssi,
        deltaMs: new Date(o.timestamp).getTime() - t0,
      })
    } else {
      const idx = seen.get(key)!
      pathRows[idx].obsCount++
    }
  }

  const stats = [
    { l: 'Observers',   v: uniqueObservers.toString(),                 c: md3.primary },
    { l: 'Observations', v: obs.length.toString(),                      c: md3.tertiary },
    { l: 'Time Spread', v: spreadMs > 0 ? `${spreadMs} ms` : '< 1 ms', c: '#f59e0b' },
    { l: 'Hops (max)', v: pkt.maxHops > 0 ? String(pkt.maxHops) : '0', c: '#818cf8' },
  ]

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <Box sx={{ mb: 3 }}>
      <Typography variant="overline" sx={{ color: md3.onSurfaceVariant, fontSize: 10, letterSpacing: '0.8px', mb: 1.5, display: 'block' }}>
        {title}
      </Typography>
      {children}
    </Box>
  )

  return (
    <Box sx={{ height: '100%', overflow: 'auto', background: md3.background }}>
      <Box sx={{ maxWidth: 900, mx: 'auto', px: { xs: 2, md: 4 }, py: 3 }}>

        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 3 }}>
          <IconButton onClick={() => navigate(-1)} size="small" sx={{ color: md3.onSurfaceVariant, mt: 0.5 }}>
            <ArrowBackIcon />
          </IconButton>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
              <Chip label={payloadName} size="small" sx={{ background: alpha(roleColor, 0.15), color: roleColor, fontWeight: 700 }} />
              <Chip label={routeName}   size="small" sx={{ background: alpha(md3.secondary, 0.12), color: md3.secondary }} />
              <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>
                {relativeTime(pkt.firstSeen)}
              </Typography>
            </Box>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: md3.outline, fontSize: 11, wordBreak: 'break-all' }}>
              {pkt.hash}
            </Typography>
          </Box>
          <Tooltip title="Replay on Live Map">
            <IconButton size="small" onClick={() => navigate('/live', { state: { replayPacket: pkt } })}
              sx={{ color: md3.primary, background: alpha(md3.primary, 0.1), '&:hover': { background: alpha(md3.primary, 0.2) } }}>
              <PlayArrowIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Stat pills */}
        <Section title="Summary">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 1.5, mb: 2 }}>
            {stats.map(s => (
              <Box key={s.l} sx={{ px: 1.5, py: 1, borderRadius: 2, background: alpha(s.c, 0.1), border: `1px solid ${alpha(s.c, 0.25)}` }}>
                <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.25, fontSize: 10 }}>{s.l}</Typography>
                <Typography variant="body2" sx={{ color: s.c, fontWeight: 700 }}>{s.v}</Typography>
              </Box>
            ))}
          </Box>
          {/* Packet type + route badges */}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(roleColor, 0.08), border: `1px solid ${alpha(roleColor, 0.2)}` }}>
              <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>Type: </Typography>
              <Typography variant="caption" sx={{ color: roleColor, fontWeight: 700 }}>{payloadName}</Typography>
            </Box>
            <Box sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(md3.outlineVariant, 0.15), border: `1px solid ${alpha(md3.outlineVariant, 0.4)}` }}>
              <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>Route: </Typography>
              <Typography variant="caption" sx={{ color: md3.onSurface, fontWeight: 600 }}>{routeName}</Typography>
            </Box>
            <Box sx={{ px: 1.5, py: 0.5, borderRadius: 2, background: alpha(md3.outlineVariant, 0.15), border: `1px solid ${alpha(md3.outlineVariant, 0.4)}` }}>
              <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>Size: </Typography>
              <Typography variant="caption" sx={{ color: md3.onSurface, fontWeight: 600 }}>{pkt.byteSize} B</Typography>
            </Box>
          </Box>
        </Section>

        {/* SVG Path Graph */}
        {pathRows.length > 0 && (
          <Section title="Path Graph">
            <Box sx={{ background: md3.surfaceContainerLow, borderRadius: 3, border: `1px solid ${md3.outlineVariant}`, p: 2 }}>
              <PathGraph pkt={pkt} rows={pathRows} />
            </Box>
          </Section>
        )}

        {/* Propagation Timeline */}
        <Section title="Propagation Timeline">
          <Box sx={{ background: md3.surfaceContainerLow, borderRadius: 3, border: `1px solid ${md3.outlineVariant}`, p: 2 }}>
            <PropagationTimeline pkt={pkt} />
          </Box>
        </Section>

      </Box>
    </Box>
  )
}
