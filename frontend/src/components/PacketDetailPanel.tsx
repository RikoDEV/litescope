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
import CloseIcon from '@mui/icons-material/Close'
import ShareIcon from '@mui/icons-material/Share'
import type { Node, PacketDetail } from '../types'
import { PAYLOAD_NAMES, ROUTE_NAMES } from '../types'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../services/api'
import { useDateLocale } from '../hooks/useDateLocale'

function hashColor(s: string) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff
  return `hsl(${h % 360}, 65%, 55%)`
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function deduplicateObs<T extends { observerId: string; snr: number | null; rssi: number | null; timestamp: string }>(obs: T[]): T[] {
  const map = new Map<string, T>()
  for (const o of obs) {
    const prev = map.get(o.observerId)
    if (!prev) { map.set(o.observerId, o); continue }
    const snrA = o.snr ?? -Infinity, snrB = prev.snr ?? -Infinity
    const rssiA = o.rssi ?? -Infinity, rssiB = prev.rssi ?? -Infinity
    if (snrA > snrB || (snrA === snrB && rssiA > rssiB) || (snrA === snrB && rssiA === rssiB && o.timestamp > prev.timestamp))
      map.set(o.observerId, o)
  }
  return [...map.values()]
}

export function parseHops(pathJson: string): string[] {
  try { return JSON.parse(pathJson) ?? [] } catch { return [] }
}

export function relativeTime(ts: string): string {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  return `${Math.round(diff / 3600)}h ago`
}

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
  result.push({ section: 'header', byte: bytes[i++] })
  const isTransport = routeType === 0 || routeType === 3
  if (isTransport) {
    for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'transport', byte: bytes[i++] })
  }
  if (i < bytes.length) {
    const pathByte = parseInt(bytes[i], 16)
    const hashSize = ((pathByte >> 6) & 3) + 1
    const hopCount = pathByte & 0x3F
    result.push({ section: 'pathLen', byte: bytes[i++] })
    const pathEnd = i + hopCount * hashSize
    while (i < pathEnd && i < bytes.length) result.push({ section: 'path', byte: bytes[i++] })
  }
  if (payloadType === 4) {
    for (let j = 0; j < 32 && i < bytes.length; j++) result.push({ section: 'pubKey', byte: bytes[i++] })
    for (let j = 0; j < 4  && i < bytes.length; j++) result.push({ section: 'timestamp', byte: bytes[i++] })
    for (let j = 0; j < 64 && i < bytes.length; j++) result.push({ section: 'signature', byte: bytes[i++] })
    if (i < bytes.length) {
      const flagsByte = parseInt(bytes[i], 16)
      result.push({ section: 'flags', byte: bytes[i++] })
      const hasLocation = (flagsByte & 0x10) !== 0
      const hasFeat1    = (flagsByte & 0x20) !== 0
      const hasFeat2    = (flagsByte & 0x40) !== 0
      const hasName     = (flagsByte & 0x80) !== 0
      if (hasLocation) {
        for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'latitude',  byte: bytes[i++] })
        for (let j = 0; j < 4 && i < bytes.length; j++) result.push({ section: 'longitude', byte: bytes[i++] })
      }
      if (hasFeat1) { for (let j = 0; j < 2 && i < bytes.length; j++) result.push({ section: 'payload', byte: bytes[i++] }) }
      if (hasFeat2) { for (let j = 0; j < 2 && i < bytes.length; j++) result.push({ section: 'payload', byte: bytes[i++] }) }
      if (hasName) {
        while (i < bytes.length) {
          const b = bytes[i]
          result.push({ section: 'name', byte: bytes[i++] })
          if (parseInt(b, 16) === 0) break
        }
      }
    }
  }
  while (i < bytes.length) result.push({ section: 'payload', byte: bytes[i++] })
  return result
}

// ── component ─────────────────────────────────────────────────────────────────

interface PacketDetailPanelProps {
  selected: PacketDetail
  onClose: () => void
  /** Override Paper sx — e.g. for full-page layout */
  paperSx?: SxProps<Theme>
  /** Highlight a specific observer's perspective */
  selectedObserverId?: string
}

export default function PacketDetailPanel({ selected, onClose, paperSx, selectedObserverId }: PacketDetailPanelProps) {
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
  const longestObs  = obsWithHops.reduce((best, o) => o.hops.length > best.hops.length ? o : best, obsWithHops[0] ?? { hops: [] })
  const focusedObs  = selectedObserverId ? (obsWithHops.find(o => o.observerId === selectedObserverId) ?? longestObs) : longestObs
  const uniqueObservers = new Set(obs.map(o => o.observerId)).size
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
            {uniqueObservers > 1 && (
              <Chip label={t('packets.observersChip', { count: uniqueObservers })} size="small"
                sx={{ background: alpha('#22c55e', 0.15), color: '#22c55e', fontSize: 11 }} />
            )}
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
            { l: t('packets.maxHops'), v: focusedObs.hops.length > 0 ? `${focusedObs.hops.length}` : '—' },
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
        {focusedObs.hops.length > 0 && (
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
        {dec && Object.keys(dec).length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>{t('packets.decoded')}</Typography>
            <Box sx={{ background: md3.surfaceContainerHighest, borderRadius: 2, p: 1.25 }}>
              {Object.entries(dec).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
                <Box key={k} sx={{ display: 'flex', gap: 1, mb: 0.4 }}>
                  <Typography variant="caption" sx={{ color: md3.outline, width: 110, flexShrink: 0, fontSize: 11 }}>{k}</Typography>
                  <Typography variant="caption" sx={{ color: md3.onSurface, fontFamily: typeof v === 'string' && v.length > 20 ? 'monospace' : undefined, wordBreak: 'break-all', fontSize: 11 }}>
                    {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        )}

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
                  {obsWithHops.map(o => (
                    <TableRow key={o.id} sx={selectedObserverId === o.observerId ? { background: alpha(md3.tertiary, 0.1) } : {}}>
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
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Box>
        )}

        {/* Colored hex */}
        <Box>
            <Typography variant="overline" sx={{ color: md3.outline, fontSize: 10, display: 'block', mb: 0.75 }}>
              {t('packets.rawHex')} ({activeRawHex.length / 2} bytes)
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 0.75 }}>
              {(HEX_SECTIONS as readonly HexSection[]).map(s => (
                hexSections.some(b => b.section === s) && (
                  <Box key={s} sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: sectionColor[s] }} />
                    <Typography variant="caption" sx={{ fontSize: 10, color: md3.outline }}>{hexSectionLabels[s]}</Typography>
                  </Box>
                )
              ))}
            </Box>
            <Box sx={{ fontFamily: 'monospace', background: md3.surfaceContainerHighest, p: 1.25, borderRadius: 2, lineHeight: 2, wordBreak: 'break-all', overflowWrap: 'anywhere' }}>
              {hexSections.map((b, i) => (
                <Box key={i} component="span" sx={{ fontSize: 11, color: sectionColor[b.section], mr: 0.4 }}>
                  {b.byte.toUpperCase()}
                </Box>
              ))}
            </Box>
        </Box>
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
