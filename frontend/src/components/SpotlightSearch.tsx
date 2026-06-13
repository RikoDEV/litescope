import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import Divider from '@mui/material/Divider'
import InputAdornment from '@mui/material/InputAdornment'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import SearchIcon from '@mui/icons-material/Search'
import DashboardIcon from '@mui/icons-material/Dashboard'
import RouterIcon from '@mui/icons-material/Router'
import ForumIcon from '@mui/icons-material/Forum'
import type { Channel, Node, Packet } from '../types'
import { PAYLOAD_NAMES } from '../types'
import { api } from '../services/api'

type ResultKind = 'packet' | 'node' | 'channel'

interface SpotlightResult {
  id: string
  kind: ResultKind
  title: string
  subtitle: string
  meta?: string
  path: string
}

const LIMIT_PER_KIND = 6

const TYPE_ALIASES: Record<string, ResultKind> = {
  packet: 'packet',
  packets: 'packet',
  pkt: 'packet',
  pkts: 'packet',
  node: 'node',
  nodes: 'node',
  channel: 'channel',
  channels: 'channel',
  chan: 'channel',
  ch: 'channel',
}

const FILTER_KINDS: Array<{ kind: ResultKind; labelKey: 'packets' | 'nodes' | 'channels' }> = [
  { kind: 'packet', labelKey: 'packets' },
  { kind: 'node', labelKey: 'nodes' },
  { kind: 'channel', labelKey: 'channels' },
]

function parseQuery(raw: string): { text: string; kinds: Set<ResultKind> } {
  const kinds = new Set<ResultKind>()
  const terms: string[] = []
  for (const part of raw.trim().split(/\s+/)) {
    const match = /^type:(.+)$/i.exec(part)
    if (match) {
      const kind = TYPE_ALIASES[match[1]?.toLowerCase() ?? '']
      if (kind) {
        kinds.add(kind)
        continue
      }
    }
    if (part) terms.push(part)
  }
  return { text: terms.join(' ').toLowerCase(), kinds }
}

function queryWithoutTypeTokens(raw: string): string {
  return raw.trim().split(/\s+/).filter(part => !/^type:.+$/i.test(part)).join(' ')
}

function packetTitle(p: Packet): string {
  const dec = p.decoded
  const label =
    dec?.text ||
    dec?.name ||
    dec?.sender ||
    dec?.channel ||
    p.hash
  return String(label)
}

function packetSubtitle(p: Packet): string {
  const payload = PAYLOAD_NAMES[p.payloadType] ?? `Type ${p.payloadType}`
  const shortHash = p.hash.slice(0, 14)
  return `${payload} · ${shortHash} · ${new Date(p.firstSeen).toLocaleString()}`
}

function contains(value: unknown, q: string): boolean {
  return String(value ?? '').toLowerCase().includes(q)
}

function nodeMatches(n: Node, q: string): boolean {
  return contains(n.name, q) ||
    contains(n.pubKey, q) ||
    contains(n.role, q) ||
    contains(n.country, q) ||
    (n.regions ?? []).some(r => contains(r, q))
}

function channelMatches(ch: Channel, q: string): boolean {
  return contains(ch.name, q) || contains(ch.hash, q)
}

function resultIcon(kind: ResultKind) {
  switch (kind) {
    case 'packet': return <DashboardIcon sx={{ fontSize: 18 }} />
    case 'node': return <RouterIcon sx={{ fontSize: 18 }} />
    case 'channel': return <ForumIcon sx={{ fontSize: 18 }} />
  }
}

export default function SpotlightSearch() {
  const theme = useTheme()
  const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [packets, setPackets] = useState<Packet[]>([])
  const [nodes, setNodes] = useState<Node[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [loadingPackets, setLoadingPackets] = useState(false)
  const [loadingStatic, setLoadingStatic] = useState(false)
  const [loadedStatic, setLoadedStatic] = useState(false)
  const requestSeq = useRef(0)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('litescope:open-spotlight', onOpen)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('litescope:open-spotlight', onOpen)
    }
  }, [])

  useEffect(() => {
    if (!open || loadedStatic || loadingStatic) return
    setLoadingStatic(true)
    Promise.all([
      api.nodes().then(r => setNodes(r.nodes ?? [])).catch(() => setNodes([])),
      api.channels().then(ch => setChannels(ch ?? [])).catch(() => setChannels([])),
    ]).finally(() => {
      setLoadedStatic(true)
      setLoadingStatic(false)
    })
  }, [loadedStatic, loadingStatic, open])

  const parsedQuery = useMemo(() => parseQuery(query), [query])
  const q = parsedQuery.text
  const kindFilter = parsedQuery.kinds
  const wantsPackets = kindFilter.size === 0 || kindFilter.has('packet')
  const wantsNodes = kindFilter.size === 0 || kindFilter.has('node')
  const wantsChannels = kindFilter.size === 0 || kindFilter.has('channel')

  useEffect(() => {
    setActiveIndex(0)
    if (!open || !wantsPackets || q.length < 2) {
      setPackets([])
      setLoadingPackets(false)
      return
    }
    const seq = ++requestSeq.current
    setLoadingPackets(true)
    const id = window.setTimeout(() => {
      api.packets(LIMIT_PER_KIND, 0, { search: q, sort: 'firstSeen', dir: 'desc' })
        .then(r => { if (seq === requestSeq.current) setPackets(r.packets ?? []) })
        .catch(() => { if (seq === requestSeq.current) setPackets([]) })
        .finally(() => { if (seq === requestSeq.current) setLoadingPackets(false) })
    }, 150)
    return () => window.clearTimeout(id)
  }, [open, q, wantsPackets])

  const results = useMemo<SpotlightResult[]>(() => {
    if (q.length < 2) return []
    const packetResults = wantsPackets
      ? packets.map(p => ({
        id: `packet:${p.hash}`,
        kind: 'packet' as const,
        title: packetTitle(p),
        subtitle: packetSubtitle(p),
        meta: `${p.obsCount} obs`,
        path: `/packets?hash=${encodeURIComponent(p.hash)}`,
      }))
      : []
    const nodeResults = wantsNodes ? nodes
      .filter(n => nodeMatches(n, q))
      .slice(0, LIMIT_PER_KIND)
      .map(n => ({
        id: `node:${n.pubKey}`,
        kind: 'node' as const,
        title: n.name || n.pubKey.slice(0, 18),
        subtitle: `${n.role || 'node'} · ${n.pubKey.slice(0, 18)}`,
        ...(n.regions?.length ? { meta: n.regions.join(', ') } : {}),
        path: `/nodes/${encodeURIComponent(n.pubKey)}`,
      })) : []
    const channelResults = wantsChannels ? channels
      .filter(ch => channelMatches(ch, q))
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, LIMIT_PER_KIND)
      .map(ch => ({
        id: `channel:${ch.hash}`,
        kind: 'channel' as const,
        title: ch.name || ch.hash,
        subtitle: ch.hash,
        meta: `${ch.messageCount} msgs`,
        path: `/channels/${encodeURIComponent(ch.hash)}`,
      })) : []
    return [...packetResults, ...nodeResults, ...channelResults]
  }, [channels, kindFilter.size, nodes, packets, q, wantsChannels, wantsNodes, wantsPackets])

  const close = () => {
    setOpen(false)
    setQuery('')
    setPackets([])
    setActiveIndex(0)
  }

  const setKindFilter = (kind: ResultKind | null) => {
    const text = queryWithoutTypeTokens(query)
    setQuery(kind ? `type:${kind} ${text}`.trim() : text)
  }

  const selectResult = (result: SpotlightResult) => {
    navigate(result.path)
    close()
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => results.length ? (i + 1) % results.length : 0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => results.length ? (i - 1 + results.length) % results.length : 0)
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault()
      selectResult(results[activeIndex])
    }
  }

  const loading = loadingPackets || loadingStatic
  const placeholder = `${t('common.search')} ${t('nav.packets').toLowerCase()}, ${t('nav.nodes').toLowerCase()}, ${t('nav.channels').toLowerCase()}`

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm"
      slotProps={{ paper: { sx: { borderRadius: 1.5, overflow: 'hidden', background: md3.surfaceContainerLow } } }}>
      <Box sx={{ p: 1.25, borderBottom: `1px solid ${md3.outlineVariant}` }}>
        <TextField
          autoFocus
          fullWidth
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          variant="standard"
          slotProps={{
            input: {
              disableUnderline: true,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: md3.onSurfaceVariant }} />
                </InputAdornment>
              ),
              endAdornment: loading ? (
                <InputAdornment position="end">
                  <CircularProgress size={18} />
                </InputAdornment>
              ) : null,
              sx: { fontSize: 18, px: 1, py: 0.5 },
            },
          }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
          <Chip
            size="small"
            label={t('common.all')}
            onClick={() => setKindFilter(null)}
            color={kindFilter.size === 0 ? 'primary' : 'default'}
            variant={kindFilter.size === 0 ? 'filled' : 'outlined'}
            sx={{ borderColor: md3.outlineVariant }}
          />
          {FILTER_KINDS.map(({ kind, labelKey }) => {
            const active = kindFilter.size === 1 && kindFilter.has(kind)
            return (
              <Chip
                key={kind}
                size="small"
                icon={resultIcon(kind)}
                label={t(`nav.${labelKey}`)}
                onClick={() => setKindFilter(kind)}
                color={active ? 'primary' : 'default'}
                variant={active ? 'filled' : 'outlined'}
                sx={{
                  borderColor: md3.outlineVariant,
                  '& .MuiChip-icon': { color: active ? md3.onPrimary : md3.onSurfaceVariant },
                }}
              />
            )
          })}
        </Box>
      </Box>

      <List sx={{ py: 0.5, maxHeight: 'min(64vh, 560px)', overflow: 'auto' }}>
        {results.length === 0 && (
          <Box sx={{ px: 2, py: 3, color: md3.onSurfaceVariant, textAlign: 'center' }}>
            <Typography variant="body2">{q.length < 2 ? t('common.search') : t('common.noData')}</Typography>
          </Box>
        )}
        {results.map((result, i) => (
          <Box key={result.id}>
            <ListItemButton
              selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => selectResult(result)}
              sx={{
                mx: 0.75, my: 0.25, borderRadius: 1,
                '&.Mui-selected': { background: alpha(md3.primary, 0.14) },
                '&.Mui-selected:hover': { background: alpha(md3.primary, 0.18) },
              }}>
              <ListItemIcon sx={{ minWidth: 36, color: md3.primary }}>
                {resultIcon(result.kind)}
              </ListItemIcon>
              <ListItemText
                primary={result.title}
                secondary={result.subtitle}
                slotProps={{
                  primary: { noWrap: true, sx: { color: md3.onSurface, fontWeight: 600 } },
                  secondary: { noWrap: true, sx: { color: md3.onSurfaceVariant, fontSize: 12 } },
                }}
              />
              {result.meta && (
                <Chip size="small" label={result.meta} variant="outlined"
                  sx={{ ml: 1, color: md3.onSurfaceVariant, borderColor: md3.outlineVariant, maxWidth: 110 }} />
              )}
            </ListItemButton>
            {i < results.length - 1 && <Divider sx={{ mx: 2, borderColor: alpha(md3.outlineVariant, 0.5) }} />}
          </Box>
        ))}
      </List>
    </Dialog>
  )
}
