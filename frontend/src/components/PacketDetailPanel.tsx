import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Avatar from '@mui/material/Avatar'
import Snackbar from '@mui/material/Snackbar'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import { alpha, useTheme, type SxProps, type Theme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTranslation } from 'react-i18next'
import Tooltip from '@mui/material/Tooltip'
import CloseIcon from '@mui/icons-material/Close'
import ShareIcon from '@mui/icons-material/Share'
import TimelineIcon from '@mui/icons-material/Timeline'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { Node, PacketDetail } from '../types'
import { PAYLOAD_NAMES, ROUTE_NAMES } from '../types'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../services/api'
import { useDateLocale } from '../hooks/useDateLocale'
import { hashColor } from '../utils/colors'
import { parseHops, deduplicateObs, relativeTime } from '../utils/packets'

// ── helpers ──────────────────────────────────────────────────────────────────

function rssiColor(v: number | null, errColor: string, outline: string) {
  if (v == null) return outline
  return v >= -70 ? '#22c55e' : v >= -90 ? '#f59e0b' : errColor
}

function snrColor(v: number | null, errColor: string, outline: string) {
  if (v == null) return outline
  return v >= 5 ? '#22c55e' : v >= 0 ? '#f59e0b' : errColor
}

type HexSection = 'header' | 'transport' | 'pathLen' | 'path' | 'pubKey' | 'timestamp' | 'signature' | 'flags' | 'latitude' | 'longitude' | 'name' | 'payload'

const HEX_SECTIONS = ['header', 'transport', 'pathLen', 'path', 'pubKey', 'timestamp', 'signature', 'flags', 'latitude', 'longitude', 'name', 'payload'] as const

function parseHexSections(rawHex: string, routeType: number, payloadType: number): { section: HexSection; byte: string }[] {
  const bytes = (rawHex.match(/.{1,2}/g) ?? [])
  if (bytes.length === 0) return []
  const result: { section: HexSection; byte: string }[] = []
  let i = 0
  const take = () => bytes[i++] ?? '00'
  result.push({ section: 'header', byte: take() })
  const isTransport = routeType === 0 || routeType === 3
  if (isTransport) {
    for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'transport', byte: take() })
  }
  if (i < bytes.length) {
    const pathByte = parseInt(bytes[i] ?? '00', 16)
    const hashSize = ((pathByte >> 6) & 3) + 1
    const hopCount = pathByte & 0x3F
    result.push({ section: 'pathLen', byte: take() })
    const pathEnd = i + hopCount * hashSize
    while (i < pathEnd && i < bytes.length) result.push({ section: 'path', byte: take() })
  }
  if (payloadType === 4) {
    for (let j = 0; j < 32 && i < bytes.length; j++) result.push({ section: 'pubKey', byte: take() })
    for (let j = 0; j < 4  && i < bytes.length; j++) result.push({ section: 'timestamp', byte: take() })
    for (let j = 0; j < 64 && i < bytes.length; j++) result.push({ section: 'signature', byte: take() })
    if (i < bytes.length) {
      const flagsByte = parseInt(bytes[i] ?? '00', 16)
      result.push({ section: 'flags', byte: take() })
      const hasLocation = (flagsByte & 0x10) !== 0
      const hasFeat1    = (flagsByte & 0x20) !== 0
      const hasFeat2    = (flagsByte & 0x40) !== 0
      const hasName     = (flagsByte & 0x80) !== 0
      if (hasLocation) {
        for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'latitude',  byte: take() })
        for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'longitude', byte: take() })
      }
      if (hasFeat1) { for (let j = 0; j < 2 && i < bytes.length; j++) result.push({ section: 'payload', byte: take() }) }
      if (hasFeat2) { for (let j = 0; j < 2 && i < bytes.length; j++) result.push({ section: 'payload', byte: take() }) }
      if (hasName) {
        while (i < bytes.length) {
          const b = bytes[i] ?? '00'
          result.push({ section: 'name', byte: take() })
          if (parseInt(b, 16) === 0) break
        }
      }
    }
  }
  while (i < bytes.length) result.push({ section: 'payload', byte: take() })
  return result
}

// ── FieldTable ────────────────────────────────────────────────────────────────

type FieldRow =
  | { kind: 'section'; label: string; section: HexSection }
  | { kind: 'field'; offset: number | null; field: string; value: string; description: string; section: HexSection; hopLink?: string | undefined }

function buildFieldRows(
  rawHex: string,
  routeType: number,
  payloadType: number,
  decoded: Record<string, unknown> | null | undefined,
  matchHop: (hex: string) => { name?: string; pubKey?: string } | undefined,
): FieldRow[] {
  const byteStr = rawHex.match(/.{1,2}/g) ?? []
  if (byteStr.length === 0) return []
  const b = (idx: number) => parseInt(byteStr[idx] ?? '0', 16)
  const hexU = (s: string | undefined) => (s ?? '00').toUpperCase()
  const sliceHex = (start: number, len: number) => byteStr.slice(start, start + len).map(hexU).join('')

  const rows: FieldRow[] = []
  let i = 0

  // ── Header ──
  rows.push({ kind: 'section', label: 'header', section: 'header' })
  rows.push({
    kind: 'field', offset: i, section: 'header',
    field: 'Header Byte', value: `0x${hexU(byteStr[i])}`,
    description: `Route: ${ROUTE_NAMES[routeType] ?? routeType}, Payload: ${PAYLOAD_NAMES[payloadType] ?? payloadType}`,
  })
  i++

  // ── Transport ──
  const isTransport = routeType === 0 || routeType === 3
  if (isTransport && i + 3 < byteStr.length) {
    rows.push({ kind: 'section', label: 'transport', section: 'transport' })
    rows.push({ kind: 'field', offset: i, section: 'transport', field: 'Next Hop', value: sliceHex(i, 2), description: '' })
    i += 2
    rows.push({ kind: 'field', offset: i, section: 'transport', field: 'Last Hop', value: sliceHex(i, 2), description: '' })
    i += 2
  }

  // ── Path length + hops ──
  if (i < byteStr.length) {
    const pathByte = b(i)
    const hashSize = ((pathByte >> 6) & 3) + 1
    const hopCount = pathByte & 0x3F
    rows.push({
      kind: 'field', offset: i, section: 'pathLen',
      field: 'Path Length', value: `0x${hexU(byteStr[i])}`,
      description: `hash_size=${hashSize} byte${hashSize > 1 ? 's' : ''}, hash_count=${hopCount}`,
    })
    i++
    if (hopCount > 0) {
      rows.push({ kind: 'section', label: `path_${hopCount}`, section: 'path' })
      for (let h = 0; h < hopCount && i + hashSize <= byteStr.length; h++) {
        const hopHex = sliceHex(i, hashSize)
        const node = matchHop(hopHex)
        rows.push({
          kind: 'field', offset: i, section: 'path',
          field: node?.name ? `Hop ${h} — ${node.name}` : `Hop ${h}`,
          value: hopHex, description: '',
          hopLink: node?.pubKey ? `/nodes?search=${encodeURIComponent(node.pubKey)}` : undefined,
        })
        i += hashSize
      }
    }
  }

  // ── ADVERT payload (structured) ──
  if (payloadType === 4) {
    rows.push({ kind: 'section', label: 'payload_advert', section: 'pubKey' })
    if (i + 32 <= byteStr.length) {
      rows.push({ kind: 'field', offset: i, section: 'pubKey', field: 'Public Key', value: sliceHex(i, 32), description: '' })
      i += 32
    }
    if (i + 4 <= byteStr.length) {
      const ts = ((b(i) << 24) | (b(i+1) << 16) | (b(i+2) << 8) | b(i+3)) >>> 0
      rows.push({ kind: 'field', offset: i, section: 'timestamp', field: 'Timestamp', value: String(ts), description: new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' })
      i += 4
    }
    if (i + 64 <= byteStr.length) {
      rows.push({ kind: 'field', offset: i, section: 'signature', field: 'Signature', value: sliceHex(i, 64), description: '' })
      i += 64
    }
    if (i < byteStr.length) {
      const flags = b(i)
      const hasLoc  = (flags & 0x10) !== 0
      const hasFeat1 = (flags & 0x20) !== 0
      const hasFeat2 = (flags & 0x40) !== 0
      const hasName = (flags & 0x80) !== 0
      const flagParts = [hasLoc && 'location', hasFeat1 && 'feat1', hasFeat2 && 'feat2', hasName && 'name'].filter(Boolean).join(', ')
      rows.push({ kind: 'field', offset: i, section: 'flags', field: 'Flags', value: `0x${hexU(byteStr[i])}`, description: flagParts || 'none' })
      i++
      if (hasLoc && i + 8 <= byteStr.length) {
        const latVal = decoded?.lat != null ? Number(decoded.lat).toFixed(5) : sliceHex(i, 4)
        const lonVal = decoded?.lon != null ? Number(decoded.lon).toFixed(5) : sliceHex(i + 4, 4)
        rows.push({ kind: 'field', offset: i,   section: 'latitude',  field: 'Latitude',  value: latVal, description: '' })
        rows.push({ kind: 'field', offset: i+4,  section: 'longitude', field: 'Longitude', value: lonVal, description: '' })
        i += 8
      }
      if (hasFeat1) i += 2
      if (hasFeat2) i += 2
      if (hasName && decoded?.name) {
        rows.push({ kind: 'field', offset: i, section: 'name', field: 'Name', value: String(decoded.name), description: '' })
      }
    }
    return rows
  }

  // ── Generic decoded payload ──
  if (decoded) {
    const SKIP = new Set(['type', 'channelHashHex', 'channelHash', 'decryptionStatus'])
    const LABELS: Record<string, string> = {
      channel: 'Channel', sender: 'Sender', senderTimestamp: 'Sender Time',
      text: 'Text', pubKey: 'PubKey', name: 'Name', lat: 'Latitude', lon: 'Longitude',
    }
    const entries = Object.entries(decoded).filter(([k, v]) => !SKIP.has(k) && v != null && v !== '')
    if (entries.length > 0) {
      rows.push({ kind: 'section', label: `payload_${payloadType}`, section: 'payload' })
      for (const [k, v] of entries) {
        rows.push({
          kind: 'field', offset: null, section: 'payload',
          field: LABELS[k] ?? k,
          value: typeof v === 'object' ? JSON.stringify(v) : String(v),
          description: '',
        })
      }
    }
  }

  return rows
}

interface FieldTableProps {
  rawHex: string
  routeType: number
  payloadType: number
  decoded: Record<string, unknown> | null | undefined
  matchHop: (hex: string) => { name?: string; pubKey?: string } | undefined
  sectionColor: Record<HexSection, string>
}

function FieldTable({ rawHex, routeType, payloadType, decoded, matchHop, sectionColor }: FieldTableProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()

  const sectionLabels: Partial<Record<string, string>> = {
    header: t('packets.hex.header'),
    transport: t('packets.hex.transport'),
    path: t('packets.hex.path'),
    pubKey: t('packets.hex.pubKey'),
    payload_advert: `${t('packets.hex.payload')} — ${PAYLOAD_NAMES[4]}`,
  }

  const rows = buildFieldRows(rawHex, routeType, payloadType, decoded, matchHop)
  if (rows.length === 0) return null

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
        {t('packets.fieldTable')}
      </Typography>
      <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, overflow: 'hidden' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
          <colgroup>
            <col style={{ width: 36 }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '28%' }} />
            <col />
          </colgroup>
          <TableHead>
            <TableRow>
              {[t('packets.col.offset'), t('packets.col.field'), t('packets.col.value'), t('packets.col.description')].map(h => (
                <TableCell key={h} sx={{ fontSize: 10, py: 0.5, color: md3.outline, background: md3.surfaceContainerHighest }}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, idx) => {
              if (row.kind === 'section') {
                // Section rows: parse dynamic labels
                let label = sectionLabels[row.label] ?? row.label
                if (row.label.startsWith('path_')) {
                  const n = parseInt(row.label.slice(5))
                  label = `${t('packets.hex.path')} (${t('packets.hopsCount', { count: n })})`
                } else if (row.label.startsWith('payload_')) {
                  label = `${t('packets.hex.payload')} — ${PAYLOAD_NAMES[payloadType] ?? payloadType}`
                }
                return (
                  <TableRow key={idx} sx={{ background: alpha(sectionColor[row.section], 0.08) }}>
                    <TableCell colSpan={4} sx={{ py: 0.5, fontSize: 11, fontWeight: 700, color: sectionColor[row.section], letterSpacing: '0.04em' }}>
                      {label}
                    </TableCell>
                  </TableRow>
                )
              }
              const isLong = row.value.length > 16
              return (
                <TableRow key={idx} sx={{ '&:hover': { background: alpha(sectionColor[row.section], 0.05) } }}>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: md3.outline, py: 0.75, width: 40, whiteSpace: 'nowrap' }}>
                    {row.offset != null ? row.offset : '—'}
                  </TableCell>
                  <TableCell sx={{ fontSize: 11, py: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={row.field}>
                    {row.hopLink ? (
                      <Box component="span" onClick={() => navigate(row.hopLink!)}
                        sx={{ color: sectionColor[row.section], cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>
                        {row.field}
                      </Box>
                    ) : row.field}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: sectionColor[row.section], py: 0.75, maxWidth: isLong ? 100 : undefined }}>
                    {isLong ? (
                      <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }} title={row.value}>
                        {row.value}
                      </Box>
                    ) : row.value}
                  </TableCell>
                  <TableCell sx={{ fontSize: 11, color: md3.onSurfaceVariant, py: 0.75 }}>
                    {row.description || '—'}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Box>
    </Box>
  )
}

// ── HexDump ───────────────────────────────────────────────────────────────────

const BYTES_PER_ROW = 16

interface HexDumpProps {
  hexSections: { section: HexSection; byte: string }[]
  sectionColor: Record<HexSection, string>
  hexSectionLabels: Record<HexSection, string>
  byteCount: number
  title: string
}

function HexDump({ hexSections, sectionColor, hexSectionLabels, byteCount, title }: HexDumpProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const [hoveredSection, setHoveredSection] = useState<HexSection | null>(null)

  const rows: { section: HexSection; byte: string }[][] = []
  for (let i = 0; i < hexSections.length; i += BYTES_PER_ROW)
    rows.push(hexSections.slice(i, i + BYTES_PER_ROW))

  const presentSections = (HEX_SECTIONS as readonly HexSection[]).filter(s =>
    hexSections.some(b => b.section === s)
  )

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.75 }}>
        <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10 }}>
          {title}
        </Typography>
        <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10, fontFamily: 'monospace' }}>
          {byteCount}B
        </Typography>
      </Box>

      {/* Legend */}
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
        {presentSections.map(s => (
          <Box
            key={s}
            onMouseEnter={() => setHoveredSection(s)}
            onMouseLeave={() => setHoveredSection(null)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5, px: 0.75, py: 0.25,
              borderRadius: 1, cursor: 'default',
              border: `1px solid ${hoveredSection === s ? sectionColor[s] : 'transparent'}`,
              background: hoveredSection === s ? alpha(sectionColor[s], 0.1) : alpha(md3.surfaceContainerHighest, 0.8),
              transition: 'all 0.15s',
            }}
          >
            <Box sx={{ width: 7, height: 7, borderRadius: '2px', background: sectionColor[s], flexShrink: 0 }} />
            <Typography variant="caption" sx={{ fontSize: 10, color: hoveredSection === s ? sectionColor[s] : md3.onSurfaceVariant, lineHeight: 1 }}>
              {hexSectionLabels[s]}
            </Typography>
          </Box>
        ))}
      </Box>

      {/* Hex rows */}
      <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, p: 1.25, overflow: 'auto' }}>
        {rows.map((row, ri) => (
          <Box key={ri} sx={{ display: 'flex', alignItems: 'center', mb: ri < rows.length - 1 ? 0.5 : 0 }}>
            {/* Offset */}
            <Box component="span" sx={{
              fontFamily: 'monospace', fontSize: 10, color: md3.outline,
              width: '3ch', flexShrink: 0, mr: 1.5, userSelect: 'none', lineHeight: 1.6,
            }}>
              {(ri * BYTES_PER_ROW).toString(16).padStart(2, '0').toUpperCase()}
            </Box>
            {/* Bytes */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0, lineHeight: 1.6 }}>
              {row.map((b, bi) => {
                const absIdx = ri * BYTES_PER_ROW + bi
                const isHovered = hoveredSection === b.section
                const isDimmed = hoveredSection !== null && hoveredSection !== b.section
                return (
                  <Box
                    key={absIdx}
                    component="span"
                    title={`${hexSectionLabels[b.section]}  offset ${absIdx.toString(16).toUpperCase().padStart(2,'0')}h`}
                    onMouseEnter={() => setHoveredSection(b.section)}
                    onMouseLeave={() => setHoveredSection(null)}
                    sx={{
                      fontFamily: 'monospace', fontSize: 11,
                      display: 'inline-block',
                      px: '2px', py: '1px',
                      mr: bi % 4 === 3 && bi < row.length - 1 ? '6px' : '2px',
                      borderRadius: '3px',
                      color: sectionColor[b.section],
                      background: isHovered ? alpha(sectionColor[b.section], 0.15) : 'transparent',
                      opacity: isDimmed ? 0.3 : 1,
                      transition: 'opacity 0.1s, background 0.1s',
                      cursor: 'default',
                      letterSpacing: '0.03em',
                    }}
                  >
                    {b.byte.toUpperCase()}
                  </Box>
                )
              })}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// ── component ─────────────────────────────────────────────────────────────────

interface PacketDetailPanelProps {
  selected: PacketDetail
  onClose: () => void
  /** Override Paper sx — e.g. for full-page layout */
  paperSx?: SxProps<Theme>
  /** Highlight a specific observer's perspective */
  selectedObserverId?: string | undefined
  onObserverSelect?: (observerId: string | null) => void
}

export default function PacketDetailPanel({ selected, onClose, paperSx, selectedObserverId, onObserverSelect }: PacketDetailPanelProps) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const hexSectionLabels: Record<HexSection, string> = {
    header: t('packets.hex.header'), transport: t('packets.hex.transport'),
    pathLen: t('packets.hex.pathLen'), path: t('packets.hex.path'),
    pubKey: t('packets.hex.pubKey'), timestamp: t('packets.hex.timestamp'),
    signature: t('packets.hex.signature'), flags: t('packets.hex.flags'),
    latitude: t('packets.hex.latitude'), longitude: t('packets.hex.longitude'),
    name: t('packets.hex.name'), payload: t('packets.hex.payload'),
  }
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))
  const navigate = useNavigate()
  const dateLocale = useDateLocale()
  const [nodes, setNodes] = useState<Node[]>([])
  const [copied, setCopied] = useState(false)
  useEffect(() => { api.nodes().then(r => setNodes(r.nodes ?? [])) }, [])
  const matchHop = (hex: string) => nodes.find(n => n.pubKey.toUpperCase().startsWith(hex.toUpperCase()))

  const obs = deduplicateObs(selected.observations ?? [])
  const obsWithHops = obs.map(o => ({ ...o, hops: parseHops(o.pathJson) }))
  const longestObs  = obsWithHops.reduce<typeof obsWithHops[number] | undefined>((best, o) => !best || o.hops.length > best.hops.length ? o : best, undefined)
  const focusedObs  = selectedObserverId ? (obsWithHops.find(o => o.observerId === selectedObserverId) ?? longestObs) : longestObs

  const times = obs.map(o => new Date(o.timestamp).getTime()).filter(Boolean)
  const propagationMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
  const activeRawHex = (selectedObserverId && focusedObs?.rawHex) ? focusedObs.rawHex : (selected.rawHex ?? '')
  const hexSections = parseHexSections(activeRawHex, selected.routeType, selected.payloadType)

  const sectionColor: Record<HexSection, string> = {
    header: md3.primary, transport: md3.tertiary, pathLen: '#a855f7', path: '#22c55e',
    pubKey: '#f59e0b', timestamp: '#06b6d4', signature: '#ec4899', flags: '#f97316',
    latitude: '#84cc16', longitude: '#10b981', name: '#e879f9', payload: md3.onSurfaceVariant,
  }

  const dec = selected.decoded as Record<string, unknown> | null | undefined

  const defaultSx: SxProps<Theme> = isMobile
    ? { position: 'fixed', top: 52, left: 0, right: 0, bottom: 56, zIndex: 1200, width: '100%', borderRadius: 0, overflow: 'auto', background: md3.surfaceContainerLow }
    : { width: 460, borderLeft: `1px solid ${md3.outlineVariant}`, overflow: 'auto', flexShrink: 0, background: md3.surfaceContainerLow, borderRadius: 0 }

  return (
    <>
    <Paper elevation={2} sx={{ ...defaultSx, ...(paperSx as object) }}>
      {/* Header */}
      <Box sx={{ px: 2, py: 1.5, borderBottom: `1px solid ${md3.outlineVariant}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 0.75 }}>
            <Chip label={PAYLOAD_NAMES[selected.payloadType] ?? selected.payloadType} size="small"
              sx={{ background: alpha(md3.primary, 0.15), color: md3.primary, fontWeight: 700, fontSize: 11 }} />
            <Chip label={ROUTE_NAMES[selected.routeType] ?? selected.routeType} size="small"
              sx={{ background: alpha(md3.secondary, 0.15), color: md3.secondary, fontSize: 11 }} />
            <Chip label={t('packets.obsChip', { count: obs.length })} size="small"
              sx={{ background: alpha(md3.tertiary, 0.15), color: md3.tertiary, fontSize: 11 }} />
            {selectedObserverId && focusedObs && focusedObs !== longestObs && (
              <Chip
                label={focusedObs.observerName || focusedObs.observerId.slice(0, 10)}
                size="small"
                sx={{ background: alpha(md3.tertiary, 0.2), color: md3.tertiary, border: `1px solid ${alpha(md3.tertiary, 0.5)}`, fontSize: 11, fontWeight: 700 }}
              />
            )}
          </Box>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: md3.outline, fontSize: 11 }}>
            {selected.hash}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1, flexShrink: 0 }}>
          <Tooltip title="Packet trace">
            <IconButton size="small" onClick={() => navigate(`/packets/${selected.hash}/trace`)} sx={{ color: md3.onSurfaceVariant }}>
              <TimelineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Replay on Live Map">
            <IconButton size="small" onClick={() => navigate('/live', { state: { replayPacket: selected } })} sx={{ color: md3.onSurfaceVariant }}>
              <PlayArrowIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <IconButton size="small" onClick={() => {
            const url = `${window.location.origin}/packets?hash=${selected.hash}`
            navigator.clipboard?.writeText(url)
            setCopied(true)
          }} sx={{ color: md3.onSurfaceVariant }}>
            <ShareIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={onClose} sx={{ color: md3.onSurfaceVariant }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      <Box sx={{ p: 2 }}>
        {/* Stats row */}
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, mb: 2 }}>
          {[
            { l: t('common.firstSeen'), v: relativeTime(selected.firstSeen) },
            { l: t('packets.propagation'), v: propagationMs > 0 ? `${(propagationMs / 1000).toFixed(1)}s` : '—' },
            { l: t('packets.maxHops'), v: focusedObs?.hops.length ? `${focusedObs.hops.length}` : '—' },
          ].map(({ l, v }) => (
            <Box key={l} sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, px: 1.25, py: 0.75, textAlign: 'center' }}>
              <Typography variant="caption" sx={{ color: md3.outline, display: 'block', fontSize: 10 }}>{l}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>{v}</Typography>
            </Box>
          ))}
        </Box>

        {/* Chat message */}
        {(() => {
          if (!dec?.text) return null
          const sender = String(dec.sender ?? t('common.unknown')) || t('common.unknown')
          const rawText = String(dec.text)
          const text = rawText.startsWith(sender + ': ') ? rawText.slice(sender.length + 2) : rawText
          const color = hashColor(sender)
          return (
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', mb: 2, background: md3.surfaceContainerHighest, borderRadius: 3, p: 1.5 }}>
              <Avatar sx={{ width: 34, height: 34, background: color, fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                {sender[0]?.toUpperCase() ?? '?'}
              </Avatar>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.25, flexWrap: 'wrap' }}>
                  <Typography variant="body2" onClick={() => navigate(`/nodes?search=${encodeURIComponent(sender)}`)}
                    sx={{ fontWeight: 700, color, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>{sender}</Typography>
                  <Typography variant="caption" sx={{ color: md3.outline }}>
                    {formatDistanceToNow(new Date(selected.firstSeen), { addSuffix: true, locale: dateLocale })}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</Typography>
              </Box>
            </Box>
          )
        })()}

        {/* Path (focused observer or longest) */}
        {focusedObs && focusedObs.hops.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10 }}>{t('packets.longestPath', { count: focusedObs.hops.length })}</Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', mt: 0.5 }}>
              {focusedObs.hops.map((hop, i) => {
                const node = matchHop(hop)
                const label = node?.name ? `${hop.toUpperCase()} · ${node.name}` : hop.toUpperCase()
                return (
                  <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {i > 0 && <Typography variant="caption" sx={{ color: md3.outline, fontSize: 12 }}>→</Typography>}
                    <Chip label={label} size="small"
                      sx={{ fontFamily: 'monospace', fontSize: 10, height: 20, background: alpha('#22c55e', 0.1), color: '#22c55e', border: `1px solid ${alpha('#22c55e', 0.3)}` }} />
                  </Box>
                )
              })}
            </Box>
          </Box>
        )}

        {/* Decoded payload */}
        {dec && (() => {
          const SKIP = new Set(['type', 'channelHashHex', ...(dec.text ? ['text'] : [])])
          const LABELS: Record<string, string> = {
            channel: 'Channel', sender: 'Sender', senderTimestamp: 'Sent at',
            text: 'Text', pubKey: 'Public Key', name: 'Name',
            lat: 'Latitude', lon: 'Longitude',
            channelHash: 'Channel Hash', decryptionStatus: 'Decryption',
          }
          const ORDER = ['channel', 'sender', 'senderTimestamp', 'text', 'name', 'lat', 'lon', 'pubKey', 'channelHash', 'decryptionStatus']
          const entries: [string, unknown][] = [
            ...ORDER.filter(k => k in dec && !SKIP.has(k) && dec[k] != null && dec[k] !== '').map(k => [k, dec[k]] as [string, unknown]),
            ...Object.entries(dec).filter(([k, v]) => !ORDER.includes(k) && !SKIP.has(k) && v != null && v !== ''),
          ]
          if (entries.length === 0) return null

          const renderVal = (key: string, value: unknown) => {
            const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
            if (key === 'sender') return (
              <Box component="span" onClick={() => navigate(`/nodes?search=${encodeURIComponent(s)}`)}
                sx={{ cursor: 'pointer', color: hashColor(s), fontWeight: 600, fontSize: 12, '&:hover': { textDecoration: 'underline' } }}>
                {s}
              </Box>
            )
            if (key === 'senderTimestamp') {
              const ts = Number(value)
              if (!Number.isNaN(ts) && ts > 0)
                return <Box component="span" sx={{ fontSize: 11, color: md3.onSurface }} title={String(ts)}>{new Date(ts * 1000).toLocaleString(dateLocale.code)}</Box>
            }
            if (key === 'decryptionStatus') {
              const color = s === 'ok' ? '#22c55e' : s === 'no_key' ? '#f59e0b' : md3.outline
              return <Chip label={s} size="small" sx={{ height: 18, fontSize: 10, background: alpha(color, 0.15), color, border: `1px solid ${alpha(color, 0.3)}` }} />
            }
            if (key === 'lat' || key === 'lon') {
              return <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 11 }}>{Number(value).toFixed(5)}°</Box>
            }
            const isLongHex = /^[0-9a-fA-F]{20,}$/.test(s)
            if (isLongHex || key === 'pubKey' || key === 'channelHash') {
              return (
                <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 10, color: md3.onSurface, wordBreak: 'break-all' }} title={s}>
                  {s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-10)}` : s}
                </Box>
              )
            }
            return <Box component="span" sx={{ fontSize: 11, color: md3.onSurface, wordBreak: 'break-word' }}>{s}</Box>
          }

          return (
            <Box sx={{ mb: 2 }}>
              <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>{t('packets.decoded')}</Typography>
              <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, overflow: 'hidden' }}>
                {entries.map(([k, v]) => (
                  <Box key={k} sx={{
                    display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.6,
                    borderBottom: `1px solid ${alpha(md3.outlineVariant, 0.4)}`,
                    '&:last-child': { borderBottom: 'none' },
                  }}>
                    <Typography variant="caption" sx={{ color: md3.outline, width: 82, flexShrink: 0, fontSize: 10 }}>
                      {LABELS[k] ?? k}
                    </Typography>
                    <Box sx={{ flex: 1, minWidth: 0 }}>{renderVal(k, v)}</Box>
                  </Box>
                ))}
              </Box>
            </Box>
          )
        })()}

        {/* Observations table */}
        {obs.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
              {t('packets.observations')} ({obs.length})
            </Typography>
            <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, overflow: 'hidden' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {[t('packets.observer'), t('packets.hops'), 'SNR', 'RSSI', t('common.lastSeen')].map(h => (
                      <TableCell key={h} sx={{ fontSize: 10, py: 0.5, color: md3.outline, background: md3.surfaceContainerHighest }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {obsWithHops.map(o => {
                    const isActive = selectedObserverId === o.observerId
                    return (
                    <TableRow key={o.id}
                      onClick={onObserverSelect ? () => onObserverSelect(isActive ? null : o.observerId) : undefined}
                      sx={{
                        background: isActive ? alpha(md3.tertiary, 0.1) : 'transparent',
                        cursor: onObserverSelect ? 'pointer' : 'default',
                        transition: 'background 0.15s',
                        ...(onObserverSelect && { '&:hover': { background: alpha(md3.tertiary, isActive ? 0.15 : 0.06) } }),
                      }}>
                      <TableCell sx={{ fontSize: 11, maxWidth: 130 }}>
                        <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                          {o.observerName || o.observerId.slice(0, 12)}
                        </Typography>
                        {o.observerIata && <Typography variant="caption" sx={{ color: md3.tertiary, fontSize: 10 }}>{o.observerIata}</Typography>}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: o.hops.length > 0 ? md3.primary : md3.outline }}>
                        {o.hops.length > 0 ? o.hops.length : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: snrColor(o.snr, md3.error, md3.outline) }}>
                        {o.snr != null ? `${o.snr} dB` : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: rssiColor(o.rssi, md3.error, md3.outline) }}>
                        {o.rssi != null ? `${o.rssi}` : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 10, color: md3.outline, whiteSpace: 'nowrap' }}>
                        {relativeTime(o.timestamp)}
                      </TableCell>
                    </TableRow>
                  )})}

                </TableBody>
              </Table>
            </Box>
          </Box>
        )}

        {/* Colored hex */}
        <HexDump
          hexSections={hexSections}
          sectionColor={sectionColor}
          hexSectionLabels={hexSectionLabels}
          byteCount={activeRawHex.length / 2}
          title={t('packets.rawHex')}
        />

        {/* Field breakdown table */}
        <FieldTable
          rawHex={activeRawHex}
          routeType={selected.routeType}
          payloadType={selected.payloadType}
          decoded={dec}
          matchHop={matchHop}
          sectionColor={sectionColor}
        />
      </Box>
    </Paper>
    <Snackbar
      open={copied}
      autoHideDuration={2000}
      onClose={() => setCopied(false)}
      message={t('packets.linkCopied')}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    />
    </>
  )
}
