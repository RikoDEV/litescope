import { useEffect, useRef, useState } from 'react'
import Popover from '@mui/material/Popover'
import Dialog from '@mui/material/Dialog'
import { QRCodeSVG } from 'qrcode.react'
import { useNavigate, useParams } from 'react-router-dom'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Avatar from '@mui/material/Avatar'
import Chip from '@mui/material/Chip'
import Badge from '@mui/material/Badge'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Collapse from '@mui/material/Collapse'
import Divider from '@mui/material/Divider'
import Switch from '@mui/material/Switch'
import FormControlLabel from '@mui/material/FormControlLabel'
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTranslation } from 'react-i18next'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import KeyIcon from '@mui/icons-material/Key'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import TagIcon from '@mui/icons-material/Tag'
import CloseIcon from '@mui/icons-material/Close'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import LockIcon from '@mui/icons-material/Lock'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import QrCode2Icon from '@mui/icons-material/QrCode2'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Channel, Packet, PacketDetail } from '../types'
import { deduplicateObs } from '../utils/packets'
import { hashColor } from '../utils/colors'
import { parseMessageSegments, isContact, isLocation, type ContactShare, type LocationShare } from '../utils/contacts'
import L from 'leaflet'
import { LS_KEYS, loadChannelKeys, saveChannelKeys, loadChannelHashNames, saveChannelHashNames, type ChannelKey } from '../utils/storage'
import { formatDistanceToNow } from 'date-fns'
import { IataFlag } from '../utils/flags'
import { useDateLocale } from '../hooks/useDateLocale'

// ── unread count storage ──────────────────────────────────────────────────────
function loadSeen(): Record<string, number> { try { return JSON.parse(localStorage.getItem(LS_KEYS.channelSeen) ?? '{}') } catch { return {} } }
function saveSeen(s: Record<string, number>) { localStorage.setItem(LS_KEYS.channelSeen, JSON.stringify(s)) }

// ── channel key storage (shared with the Decoder page via utils/storage) ───────
type StoredKey = ChannelKey
const loadKeys = loadChannelKeys
const saveKeys = saveChannelKeys

async function deriveHashtagKey(name: string): Promise<string> {
  const n = name.startsWith('#') ? name : '#' + name
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n))
  return Array.from(new Uint8Array(digest)).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Copy a Uint8Array into a fresh ArrayBuffer (WebCrypto wants ArrayBuffers).
function ab(u8: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u8.length); new Uint8Array(b).set(u8); return b
}

// MeshCore channel messages are AES-128 *ECB* (each 16-byte block decrypted
// independently). WebCrypto exposes no ECB/raw-block mode, so we run AES-CBC
// (IV=0) and undo the chaining ourselves: CBC gives P_i = D(B_i) XOR B_{i-1}
// (B_{-1}=IV=0), so XOR-ing each block back with the preceding ciphertext block
// recovers the raw ECB block D(B_i). To stop WebCrypto from stripping (and then
// rejecting) PKCS7 padding on the final block, we append one extra ciphertext
// block crafted to decrypt to a full 0x10 padding block, which it discards.
async function aesEcbDecrypt(ct: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(16)
  const dk = await crypto.subtle.importKey('raw', ab(key), { name: 'AES-CBC' }, false, ['decrypt'])
  const ek = await crypto.subtle.importKey('raw', ab(key), { name: 'AES-CBC' }, false, ['encrypt'])
  const lastBlock = ct.slice(ct.length - 16)
  const target = new Uint8Array(16)
  for (let j = 0; j < 16; j++) target[j] = lastBlock[j] ^ 0x10
  // E(target) = first block of CBC-encrypt(IV=0) of target.
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ek, ab(target))).slice(0, 16)
  const feed = new Uint8Array(ct.length + 16); feed.set(ct); feed.set(extra, ct.length)
  const dec = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, dk, ab(feed)))
  const out = new Uint8Array(ct.length)
  out.set(dec.slice(0, 16)) // block 0: D(B0) XOR IV(0) = D(B0)
  for (let i = 16; i < ct.length; i += 16)
    for (let j = 0; j < 16; j++) out[i + j] = dec[i + j] ^ ct[i - 16 + j]
  return out
}

async function tryDecrypt(encHex: string, macHex: string, keyHex: string): Promise<{ sender: string; text: string } | null> {
  try {
    const key = hexToBytes(keyHex)
    const mac = hexToBytes(macHex)
    const ct  = hexToBytes(encHex)
    if (key.length !== 16 || mac.length !== 2 || ct.length === 0 || ct.length % 16 !== 0) return null
    const secret = new Uint8Array(32); secret.set(key)
    const hmacKey = await crypto.subtle.importKey('raw', ab(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ab(ct)))
    if (sig[0] !== mac[0] || sig[1] !== mac[1]) return null
    const plain = await aesEcbDecrypt(ct, key)
    if (plain.length < 5) return null
    let text = new TextDecoder('utf-8', { fatal: false }).decode(plain.slice(5))
    const nul = text.indexOf('\0'); if (nul >= 0) text = text.slice(0, nul)
    if (!text.trim()) return null
    const ci = text.indexOf(': ')
    if (ci > 0 && ci < 50) return { sender: text.slice(0, ci), text: text.slice(ci + 2) }
    return { sender: '', text }
  } catch { return null }
}

function hexToBytes(h: string): Uint8Array {
  const c = h.replace(/\s/g, ''); const a = new Uint8Array(c.length / 2)
  for (let i = 0; i < a.length; i++) a[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16)
  return a
}

// A GRP_TXT packet needs a client-side decrypt attempt when the backend could
// not decrypt it — either because no keys were configured (`no_key`) or the
// configured keys didn't match (`decryption_failed`). In both cases the payload
// still carries the MAC + ciphertext, so a key added in the Key Manager can
// unlock it in the browser. Treat the two statuses identically here.
const CLIENT_DECRYPTABLE = new Set(['no_key', 'decryption_failed'])
function needsClientDecrypt(status?: string): boolean {
  return status !== undefined && CLIENT_DECRYPTABLE.has(status)
}

// First emoji in the name (full grapheme cluster), else first letter, else '?'
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
type Segmenter = { segment(s: string): Iterable<{ segment: string }> }
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter
const segmenter = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'grapheme' }) : null
function avatarGlyph(name: string): string {
  if (!name) return '?'
  const graphemes = segmenter
    ? Array.from(segmenter.segment(name), s => s.segment)
    : Array.from(name)
  for (const g of graphemes) {
    if (EMOJI_RE.test(g)) return g
  }
  return name[0]?.toUpperCase() ?? '?'
}

// ── message paging ────────────────────────────────────────────────────────────
const PAGE_SIZE = 100

// ── component ────────────────────────────────────────────────────────────────
export default function Channels() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))
  const { t } = useTranslation()
  const dateLocale = useDateLocale()
  const navigate = useNavigate()
  const { hash: urlHash } = useParams<{ hash?: string }>()
  const [channels, setChannels]     = useState<Channel[]>([])
  const [selected, setSelected]     = useState<Channel | null>(null)
  const [messages, setMessages]     = useState<Packet[]>([])
  const [showKeyMgr, setShowKeyMgr] = useState(false)
  const [decrypted, setDecrypted]   = useState<Record<number, { sender: string; text: string }>>({})
  const [storedKeys, setStoredKeys] = useState<StoredKey[]>(loadKeys)
  const [seenCounts, setSeenCounts] = useState<Record<string, number>>(loadSeen)
  const [nodes, setNodes]           = useState<{ pubKey: string; name: string }[]>([])
  const [hasMore, setHasMore]       = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  // Collapse runs of identical consecutive messages (same sender + text) into a
  // single bubble with a ×N count — handy when a node retransmits the same line
  // 2–3 times. Persisted per-browser.
  const [stackDuplicates, setStackDuplicates] = useState(() => localStorage.getItem(LS_KEYS.channelStackDuplicates) === '1')
  useEffect(() => { localStorage.setItem(LS_KEYS.channelStackDuplicates, stackDuplicates ? '1' : '0') }, [stackDuplicates])
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const skipAutoScroll = useRef(false)
  const initialLoad = useRef(false)
  // Persisted channelHash → decrypted-name map, re-applied to every server-loaded
  // channel list so client-side names survive refetches and reloads.
  const hashNames = useRef<Record<string, string>>(loadChannelHashNames())
  const applyNames = (chs: Channel[]) =>
    chs.map(ch => hashNames.current[ch.hash] ? { ...ch, name: hashNames.current[ch.hash] } : ch)

  useEffect(() => {
    if (skipAutoScroll.current) { skipAutoScroll.current = false; return }
    // Initial channel load: jump instantly so the smooth animation doesn't pass
    // through the top and spuriously trigger loadMore().
    const behavior = initialLoad.current ? 'auto' : 'smooth'
    initialLoad.current = false
    bottomRef.current?.scrollIntoView({ behavior })
  }, [messages])
  useEffect(() => { api.channels().then(chs => setChannels(applyNames(chs))) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.nodes().then(res => setNodes((res.nodes ?? []).map(n => ({ pubKey: n.pubKey, name: n.name }))))
  }, [])

  // Sync selected channel with URL path param
  useEffect(() => {
    if (!urlHash) { setSelected(null); return }
    if (!channels.length) return
    const ch = channels.find(c => c.hash === urlHash)
    if (ch && ch.hash !== selected?.hash) selectChannelData(ch)
  }, [urlHash, channels]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectChannel = (ch: Channel) => {
    navigate(`/channels/${ch.hash}`, { replace: false })
  }

  const selectChannelData = async (ch: Channel) => {
    setSelected(ch); setDecrypted({})
    document.title = `${ch.name} — liteScope`
    const msgs = await api.channelMessages(ch.hash, PAGE_SIZE)
    initialLoad.current = true
    setMessages(msgs)
    setHasMore(msgs.length >= PAGE_SIZE)
    setShowScrollBottom(false)
    decryptBatch(msgs, storedKeys)
    setSeenCounts(prev => {
      const updated = { ...prev, [ch.hash]: ch.messageCount }
      saveSeen(updated)
      return updated
    })
  }

  const loadMore = async () => {
    if (!selected || loadingMore || !hasMore) return
    setLoadingMore(true)
    const container = scrollRef.current
    const prevHeight = container?.scrollHeight ?? 0
    try {
      const older = await api.channelMessages(selected.hash, PAGE_SIZE, messages.length)
      if (older.length > 0) {
        skipAutoScroll.current = true
        setMessages(prev => [...prev, ...older]) // older messages render at the top
        decryptBatch(older, storedKeys)
        // keep the viewport anchored on the message the user was looking at
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - prevHeight
        })
      }
      setHasMore(older.length >= PAGE_SIZE)
    } finally {
      setLoadingMore(false)
    }
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop < 80) loadMore()
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBottom(fromBottom > 240)
  }

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setShowScrollBottom(false)
  }

  const clickSender = (senderName: string) => {
    if (!senderName || senderName === 'Unknown') return
    const q = senderName.toLowerCase().trim()
    // 1. exact  2. node name contains sender  3. sender contains node name
    const match =
      nodes.find(n => n.name.toLowerCase() === q) ??
      nodes.find(n => n.name.toLowerCase().includes(q)) ??
      nodes.find(n => q.includes(n.name.toLowerCase()) && n.name.length > 2)
    if (match) navigate(`/nodes/${match.pubKey}`)
    else navigate(`/nodes?search=${encodeURIComponent(senderName)}`)
  }

  const decryptBatch = async (msgs: Packet[], keys: StoredKey[]) => {
    const updates: Record<number, { sender: string; text: string }> = {}
    const nameMap: Record<string, string> = {}   // channelHash → key.name
    for (const msg of msgs) {
      const d = msg.decoded
      if (!d || !needsClientDecrypt(d.decryptionStatus)) continue
      const mac = d.mac as string | undefined; const enc = d.encryptedData as string | undefined
      if (!mac || !enc) continue
      for (const k of keys) {
        const r = await tryDecrypt(enc, mac, k.key)
        if (r) {
          updates[msg.id] = r
          const hash = msg.channelHash ?? (d.channelHashHex as string | undefined)
          if (hash) nameMap[hash] = k.name
          break
        }
      }
    }
    if (Object.keys(updates).length > 0) setDecrypted(p => ({ ...p, ...updates }))
    if (Object.keys(nameMap).length > 0) {
      // Remember the learned hash→name mappings so the channel stays named across
      // refetches and reloads, not just in this render's channel list.
      hashNames.current = { ...hashNames.current, ...nameMap }
      saveChannelHashNames(hashNames.current)
      setChannels(prev => prev.map(ch => nameMap[ch.hash] ? { ...ch, name: nameMap[ch.hash] } : ch))
    }
  }

  useEffect(() => {
    let hiddenAt: number | null = null
    const onVisibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return }
      const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0
      hiddenAt = null
      if (hiddenMs < 5000) return
      api.channels().then(chs => setChannels(applyNames(chs)))
      if (selected) selectChannelData(selected)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsub = stream.subscribe(async msg => {
      // Live count updates: a previously-seen message gained observers/hops as it
      // propagated — patch the matching message in place.
      if (msg.type === 'packetUpdate') {
        const u = msg.data
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === u.id)
          if (idx < 0) return prev
          const n = [...prev]
          n[idx] = {
            ...n[idx], obsCount: u.obsCount, maxHops: u.maxHops,
            hopSize: u.hopSize ?? n[idx].hopSize,
            bestScope: u.bestScope ?? n[idx].bestScope,
            bestPath: u.bestPath ?? n[idx].bestPath,
            bestObserver: u.bestObserver ?? n[idx].bestObserver,
            regions: u.regions ?? n[idx].regions,
          }
          return n
        })
        return
      }
      if (msg.type !== 'packet') return
      const d = msg.data.decoded
      if (!d || (d.decryptionStatus !== 'decrypted' && !needsClientDecrypt(d.decryptionStatus))) return
      if (selected && msg.data.channelHash === selected.hash) {
        setMessages(p => [msg.data, ...p])
      }
      setChannels(prev => {
        const idx = prev.findIndex(c => c.hash === msg.data.channelHash)
        if (idx >= 0) { const n = [...prev]; n[idx] = { ...n[idx], messageCount: n[idx].messageCount + 1 }; return n }
        const h = msg.data.channelHash ?? ''
        return [...prev, { hash: h, name: hashNames.current[h] ?? (d.channel as string) ?? h ?? 'Unknown', messageCount: 1 }]
      })
      // Attempt client-side decryption for every incoming encrypted message —
      // not just the open channel — so a channel we hold a key for gets named
      // and promoted out of the collapsed "Encrypted" group as soon as a message
      // arrives. decryptBatch also renames the matching channel in the list.
      if (needsClientDecrypt(d.decryptionStatus)) decryptBatch([msg.data], storedKeys)
    })
    return unsub
  }, [selected, storedKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-attempt decryption of already-loaded messages whenever the key set
  // changes (e.g. the user just added a key in the Key Manager) so the channel
  // unlocks without needing to reselect it.
  useEffect(() => {
    if (messages.length) decryptBatch(messages, storedKeys)
  }, [storedKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  const persistKeys = (k: StoredKey[]) => { setStoredKeys(k); saveKeys(k) }

  const showSidebar = !isMobile || (!selected && !showKeyMgr)
  const showMain    = !isMobile || selected || showKeyMgr

  // A single-byte channel hash is shared by many different channels, so the
  // loaded page mixes in messages from other channels that collide on the same
  // byte. Once we can read at least one message (this channel is keyed), show
  // only the messages we can actually decrypt — the ones that belong to this
  // channel's key. For an unkeyed channel (nothing readable) we keep showing the
  // raw encrypted messages so they can still be browsed.
  const isReadable = (m: Packet) => !!decrypted[m.id] || m.decoded?.decryptionStatus === 'decrypted'
  const channelKeyed = messages.some(isReadable)
  const visibleMessages = channelKeyed ? messages.filter(isReadable) : messages

  // Stacking key: readable messages group by sender + text; still-encrypted ones
  // group by their raw ciphertext (identical retransmits), and fall back to a
  // unique per-message key so unreadable, non-identical messages never merge.
  const stackKey = (m: Packet): string => {
    const cdec = decrypted[m.id]
    const d = m.decoded
    if (needsClientDecrypt(d?.decryptionStatus) && !cdec) {
      const enc = d?.encryptedData as string | undefined
      return enc ? `e:${enc}` : `u:${m.id}`
    }
    const sender = cdec?.sender || (d?.sender as string) || 'Unknown'
    const text = cdec?.text || (d?.text as string) || ''
    return `r:${sender} ${text}`
  }

  // Display rows in chat order (oldest→newest). When stacking is on, each run of
  // consecutive same-key messages collapses to one row keyed by its newest
  // member (so time/obs/hops reflect the latest send) with a repeat count.
  type Row = { msg: Packet; count: number; key: string }
  const displayRows: Row[] = (() => {
    const ordered = [...visibleMessages].reverse()
    if (!stackDuplicates) return ordered.map(m => ({ msg: m, count: 1, key: String(m.id) }))
    const rows: Row[] = []
    for (const m of ordered) {
      const k = stackKey(m)
      const last = rows[rows.length - 1]
      if (last && last.key === k) { last.count++; last.msg = m }
      else rows.push({ msg: m, count: 1, key: k })
    }
    return rows
  })()

  return (
    <Box sx={{ display: 'flex', height: '100%', background: md3.background }}>
      {/* ── Channel list ── */}
      {showSidebar && (
        <Paper elevation={1} sx={{ width: { xs: '100%', md: 220 }, display: 'flex', flexDirection: 'column', borderRight: { md: `1px solid ${md3.outlineVariant}` }, borderRadius: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1, borderBottom: `1px solid ${md3.outlineVariant}` }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('channels.count', { count: channels.length })}</Typography>
            <Tooltip title={t('channels.manageKeys')}>
              <IconButton size="small" onClick={() => setShowKeyMgr(v => !v)} sx={{ color: showKeyMgr ? md3.primary : md3.onSurfaceVariant }}>
                <KeyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <ChannelList channels={channels} selected={selected} onSelect={selectChannel} seenCounts={seenCounts} />
        </Paper>
      )}

      {/* ── Main ── */}
      {showMain && <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {showKeyMgr ? (
          <KeyManager keys={storedKeys} onChange={persistKeys} onClose={() => { setShowKeyMgr(false); if (isMobile) navigate('/channels') }} />
        ) : selected ? (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, borderBottom: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow, flexShrink: 0 }}>
              {isMobile && (
                <IconButton size="small" onClick={() => navigate('/channels')} sx={{ color: md3.onSurfaceVariant, mr: 0.5 }}>
                  <ArrowBackIcon fontSize="small" />
                </IconButton>
              )}
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: hashColor(selected.name) }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{selected.name}</Typography>
              <Typography variant="caption" sx={{ color: md3.outline, display: { xs: 'none', sm: 'block' } }}>#{selected.hash}</Typography>
              <Tooltip title={t('channels.stackTooltip')}>
                <FormControlLabel
                  sx={{ ml: 'auto', mr: 0 }}
                  control={<Switch size="small" checked={stackDuplicates} onChange={e => setStackDuplicates(e.target.checked)} />}
                  label={<Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: { xs: 'none', sm: 'inline' } }}>{t('channels.stackDuplicates')}</Typography>}
                />
              </Tooltip>
              <Typography variant="caption" sx={{ color: md3.outline }}>{t('channels.messages', { count: visibleMessages.length })}</Typography>
            </Box>
            <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <Box ref={scrollRef} onScroll={onScroll} sx={{ position: 'absolute', inset: 0, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {hasMore && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
                  <Button size="small" variant="text" onClick={loadMore} disabled={loadingMore} sx={{ color: md3.onSurfaceVariant }}>
                    {loadingMore ? t('channels.loadingMore') : t('channels.loadMore')}
                  </Button>
                </Box>
              )}
              {displayRows.map(({ msg, count }) => {
                const dec    = msg.decoded
                const cdec   = decrypted[msg.id]
                const noKey  = needsClientDecrypt(dec?.decryptionStatus) && !cdec
                const sender = cdec?.sender || (dec?.sender as string) || 'Unknown'
                const rawT   = cdec?.text || (dec?.text as string) || ''
                const text   = rawT.startsWith(sender + ': ') ? rawT.slice(sender.length + 2) : rawT
                return (
                  <Box key={msg.id} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', opacity: noKey ? 0.5 : 1 }}>
                    <Avatar
                      onClick={() => clickSender(sender)}
                      sx={{ width: 34, height: 34, background: hashColor(sender), fontSize: 14, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
                    >
                      {avatarGlyph(sender)}
                    </Avatar>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      {/* Header: sender + time + encryption badge */}
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.25, flexWrap: 'wrap' }}>
                        <Typography
                          variant="body2"
                          onClick={() => clickSender(sender)}
                          sx={{ fontWeight: 700, color: hashColor(sender), cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                        >{sender}</Typography>
                        <Tooltip title={new Date(msg.firstSeen).toLocaleString()} placement="top">
                          <Typography variant="caption" sx={{ color: md3.outline, cursor: 'default' }}>
                            {formatDistanceToNow(new Date(msg.firstSeen), { addSuffix: true, locale: dateLocale })}
                          </Typography>
                        </Tooltip>
                        {noKey && <Chip label={`🔒 ${t('channels.encrypted')}`} size="small" sx={{ fontSize: 10, height: 18, background: alpha('#f59e0b', 0.15), color: '#f59e0b' }} />}
                        {cdec && <Chip label={`🔓 ${t('channels.decrypted')}`} size="small" sx={{ fontSize: 10, height: 18, background: alpha('#22c55e', 0.15), color: '#22c55e' }} />}
                        {count > 1 && (
                          <Tooltip title={t('channels.stackedTimes', { count })}>
                            <Chip label={`×${count}`} size="small" sx={{ fontSize: 10, height: 18, fontWeight: 700, background: alpha(md3.primary, 0.15), color: md3.primary }} />
                          </Tooltip>
                        )}
                      </Box>

                      {/* Message body */}
                      {noKey
                        ? <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace' }}>{(dec?.encryptedData as string | undefined)?.slice(0, 40) ?? ''}…</Typography>
                        : <MessageText text={text} onMentionClick={clickSender} channels={channels} onChannelClick={selectChannel} />
                      }

                      {/* Meta row: obs · hops popover · link */}
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
                        {msg.obsCount > 0 && <ObsPopover packet={msg} />}
                        {msg.maxHops > 0 && (
                          <>
                            <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>·</Typography>
                            <HopsPopover packet={msg} nodes={nodes} />
                          </>
                        )}
                        {msg.bestScope && (
                          <>
                            <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>·</Typography>
                            <Chip label={msg.bestScope} size="small" sx={{ fontSize: 10, height: 18, background: alpha(md3.primary, 0.1), color: md3.primary }} />
                          </>
                        )}
                        <Tooltip title="View packet">
                          <IconButton size="small" onClick={() => navigate(`/packets?hash=${msg.hash}`)}
                            sx={{ color: md3.outline, p: 0.25, ml: 'auto', '&:hover': { color: md3.primary } }}>
                            <OpenInNewIcon sx={{ fontSize: 13 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </Box>
                  </Box>
                )
              })}
              <div ref={bottomRef} />
            </Box>
            {showScrollBottom && (
              <IconButton
                onClick={scrollToBottom}
                size="small"
                sx={{
                  position: 'absolute', bottom: 16, right: 16,
                  background: md3.surfaceContainerHigh, color: md3.onSurface,
                  border: `1px solid ${md3.outlineVariant}`,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                  '&:hover': { background: md3.surfaceContainerHighest },
                }}
              >
                <KeyboardArrowDownIcon fontSize="small" />
              </IconButton>
            )}
            </Box>
          </>
        ) : (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, color: md3.onSurfaceVariant }}>
            <KeyIcon sx={{ fontSize: 48, opacity: 0.4 }} />
            <Typography variant="body1">{t('channels.selectChannel')}</Typography>
            <Button variant="outlined" size="small" onClick={() => setShowKeyMgr(true)}>{t('channels.manageKeys')}</Button>
          </Box>
        )}
      </Box>}
    </Box>
  )
}

// ── Message text with mention + channel parsing ───────────────────────────────
const TOKEN_RE = /@\[([^\]]+)\]|(https?:\/\/[^\s]+)|#(\S+)/g

function MessageText(props: {
  text: string
  onMentionClick: (name: string) => void
  channels: Channel[]
  onChannelClick: (ch: Channel) => void
}) {
  // Contact/location cards are block-level, so split them out and render the
  // surrounding text inline around each card.
  const segments = parseMessageSegments(props.text)
  if (segments.length === 1 && typeof segments[0] === 'string') {
    return <InlineText {...props} />
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {segments.map((seg, i) =>
        typeof seg === 'string'
          ? (seg.trim() ? <InlineText key={i} {...props} text={seg} /> : null)
          : isContact(seg) ? <ContactCard key={i} contact={seg} />
          : isLocation(seg) ? <LocationCard key={i} loc={seg} />
          : null
      )}
    </Box>
  )
}

// ── Location-share card with a tiny map ────────────────────────────────────────
function LocationCard({ loc }: { loc: LocationShare }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const divRef = useRef<HTMLDivElement>(null)
  const isDark = theme.palette.mode === 'dark'

  useEffect(() => {
    if (!divRef.current) return
    const map = L.map(divRef.current, {
      center: [loc.lat, loc.lon], zoom: 13,
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    })
    L.tileLayer(
      isDark ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
             : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, subdomains: isDark ? 'abcd' : 'abc' },
    ).addTo(map)
    L.circleMarker([loc.lat, loc.lon], { radius: 7, color: '#fff', fillColor: md3.primary, fillOpacity: 1, weight: 2.5 }).addTo(map)
    return () => { map.remove() }
  }, [loc.lat, loc.lon, isDark, md3.primary])

  const osmUrl = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=15/${loc.lat}/${loc.lon}`

  return (
    <Box sx={{ maxWidth: 300, borderRadius: 2, overflow: 'hidden', border: `1px solid ${md3.outlineVariant}` }}>
      <Box component="a" href={osmUrl} target="_blank" rel="noopener noreferrer" sx={{ display: 'block' }}>
        <div ref={divRef} style={{ height: 150, cursor: 'pointer' }} />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, background: alpha(md3.surfaceContainerHighest, 0.6) }}>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: 11, color: md3.onSurfaceVariant }}>
          {loc.lat.toFixed(5)}, {loc.lon.toFixed(5)}
        </Typography>
        <Tooltip title="OpenStreetMap">
          <IconButton size="small" component="a" href={osmUrl} target="_blank" rel="noopener noreferrer" sx={{ p: 0.25, ml: 'auto', color: md3.outline }}>
            <OpenInNewIcon sx={{ fontSize: 13 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  )
}

// ── Contact-share card with a QR action ────────────────────────────────────────
function ContactCard({ contact }: { contact: ContactShare }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [qrOpen, setQrOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const color = hashColor(contact.pubKey)
  const shortKey = `${contact.pubKey.slice(0, 8)}…${contact.pubKey.slice(-6)}`
  // MeshCore deep link the mobile app understands when scanned.
  const qrValue = `meshcore://contact/add?${new URLSearchParams({
    name: contact.name, public_key: contact.pubKey, type: String(contact.type),
  }).toString()}`

  const copyKey = () => {
    navigator.clipboard?.writeText(contact.pubKey).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <>
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.25, p: 1, maxWidth: 340,
        borderRadius: 2, border: `1px solid ${md3.outlineVariant}`,
        background: alpha(md3.surfaceContainerHighest, 0.6),
      }}>
        <Avatar sx={{ width: 38, height: 38, background: color, fontSize: 15, fontWeight: 700, flexShrink: 0 }}>
          {avatarGlyph(contact.name)}
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {contact.name}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10 }}>{shortKey}</Typography>
            <Tooltip title={copied ? '✓' : contact.pubKey}>
              <IconButton size="small" onClick={copyKey} sx={{ p: 0.25, color: md3.outline }}>
                <ContentCopyIcon sx={{ fontSize: 12 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        <Button size="small" variant="outlined" startIcon={<QrCode2Icon />} onClick={() => setQrOpen(true)}
          sx={{ flexShrink: 0, textTransform: 'none' }}>
          {t('channels.showQr')}
        </Button>
      </Box>

      <Dialog open={qrOpen} onClose={() => setQrOpen(false)}>
        <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, minWidth: 260 }}>
          <Typography variant="overline" sx={{ color: md3.onSurfaceVariant, lineHeight: 1 }}>{t('channels.sharedContact')}</Typography>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{contact.name}</Typography>
          <Box sx={{ p: 1.5, background: '#fff', borderRadius: 2 }}>
            <QRCodeSVG value={qrValue} size={220} level="M" marginSize={2} />
          </Box>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, textAlign: 'center' }}>{t('channels.scanToAdd')}</Typography>
          <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', textAlign: 'center' }}>
            {contact.pubKey}
          </Typography>
        </Box>
      </Dialog>
    </>
  )
}

// Inline message text (mentions / URLs / #channels).
function InlineText({ text, onMentionClick, channels, onChannelClick }: {
  text: string
  onMentionClick: (name: string) => void
  channels: Channel[]
  onChannelClick: (ch: Channel) => void
}) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const parts: React.ReactNode[] = []
  let last = 0; let m: RegExpExecArray | null; let i = 0
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={i++}>{text.slice(last, m.index)}</span>)
    if (m[1] !== undefined) {
      // @[mention]
      const name = m[1]
      parts.push(
        <Box key={i++} component="span" onClick={() => onMentionClick(name)}
          sx={{ display: 'inline-flex', alignItems: 'center', px: 0.6, py: 0.1, borderRadius: 1,
            background: alpha(md3.primary, 0.12), color: md3.primary,
            fontWeight: 600, fontSize: '0.8em', cursor: 'pointer',
            '&:hover': { background: alpha(md3.primary, 0.22) } }}>
          @{name}
        </Box>
      )
    } else if (m[2] !== undefined) {
      // URL
      const url = m[2]
      parts.push(
        <Box key={i++} component="a" href={url} target="_blank" rel="noopener noreferrer"
          sx={{ color: md3.primary, textDecoration: 'underline', wordBreak: 'break-all',
            '&:hover': { color: md3.tertiary } }}>
          {url}
        </Box>
      )
    } else {
      // #channel
      const tag = m[3]
      const ch = channels.find(c => c.name.toLowerCase() === tag.toLowerCase() ||
        c.name.toLowerCase() === '#' + tag.toLowerCase())
      parts.push(
        <Box key={i++} component="span" onClick={() => ch ? onChannelClick(ch) : undefined}
          sx={{ display: 'inline-flex', alignItems: 'center', px: 0.6, py: 0.1, borderRadius: 1,
            background: alpha(md3.tertiary, 0.12), color: ch ? md3.tertiary : md3.outline,
            fontWeight: 600, fontSize: '0.8em', cursor: ch ? 'pointer' : 'default',
            '&:hover': ch ? { background: alpha(md3.tertiary, 0.22) } : {} }}>
          #{tag}
        </Box>
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(<span key={i++}>{text.slice(last)}</span>)
  return (
    <Typography variant="body2" sx={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
      {parts}
    </Typography>
  )
}

// ── Hops popover ─────────────────────────────────────────────────────────────
function HopsPopover({ packet, nodes }: { packet: Packet; nodes: { pubKey: string; name: string }[] }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [detail, setDetail] = useState<PacketDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEnter = (e: React.MouseEvent<HTMLElement>) => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setAnchor(e.currentTarget)
    if (!detail && !loading) {
      setLoading(true)
      api.packet(packet.hash).then(d => { setDetail(d); setLoading(false) }).catch(() => setLoading(false))
    }
  }
  const handleLeave = () => {
    closeTimer.current = setTimeout(() => setAnchor(null), 180)
  }
  const keepOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current) }

  // Group by observation (deduplicated), each with its parsed hops
  const obsHops = deduplicateObs(detail?.observations ?? []).map(o => ({
    name: o.observerName || o.observerId.slice(0, 12),
    iata: o.observerIata,
    hops: (() => { try { return JSON.parse(o.pathJson) as string[] } catch { return [] } })(),
  })).filter(o => o.hops.length > 0)

  return (
    <>
      <Typography
        variant="caption"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        sx={{
          fontSize: 10, color: anchor ? md3.primary : md3.outline,
          cursor: 'default', borderBottom: `1px dashed`,
          borderColor: anchor ? md3.primary : 'transparent',
          transition: 'color 0.15s, border-color 0.15s',
        }}
      >
        {packet.maxHops} hops{packet.hopSize ? ` (${packet.hopSize}b)` : ''}
      </Typography>

      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        disableRestoreFocus
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        sx={{ pointerEvents: 'none' }}
        slotProps={{
          root: { style: { pointerEvents: 'none' } },
          paper: {
            onMouseEnter: keepOpen,
            onMouseLeave: handleLeave,
            style: { pointerEvents: 'auto' },
            sx: {
              mt: 0.5, p: 1.5, borderRadius: 2, minWidth: 180, maxWidth: 300,
              background: md3.surfaceContainerHigh,
              border: `1px solid ${md3.outlineVariant}`,
              boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            },
          },
        }}
      >
        {loading && (
          <Typography variant="caption" sx={{ color: md3.outline }}>Loading…</Typography>
        )}
        {!loading && obsHops.length === 0 && (
          <Typography variant="caption" sx={{ color: md3.outline }}>No path data</Typography>
        )}
        {!loading && obsHops.map((o, oi) => (
          <Box key={oi} sx={{ mb: oi < obsHops.length - 1 ? 1 : 0 }}>
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontWeight: 600, display: 'block', mb: 0.5 }}>
              {o.name}{o.iata ? <> · <IataFlag iata={o.iata} size={11} style={{ marginRight: 2 }} />{o.iata}</> : ''}
            </Typography>
            {o.hops.map((hop, hi) => {
              const byteLen = hop.length / 2
              const label = `${byteLen}b`
              const color = byteLen === 1 ? '#f59e0b' : byteLen === 2 ? md3.primary : '#22c55e'
              const nodeName = nodes.find(n => n.pubKey.toUpperCase().startsWith(hop.toUpperCase()))?.name
              return (
                <Box key={hi} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
                  <Typography variant="caption" sx={{ color: md3.outline, fontSize: 9, width: 14, textAlign: 'right', flexShrink: 0 }}>
                    {hi + 1}.
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', color: md3.onSurface, fontSize: 11, letterSpacing: '0.5px' }}>
                    {hop.toUpperCase()}
                  </Typography>
                  {nodeName && (
                    <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {nodeName}
                    </Typography>
                  )}
                  <Box sx={{ ml: 'auto', px: 0.75, py: 0.1, borderRadius: 1, background: alpha(color, 0.15), border: `1px solid ${alpha(color, 0.4)}`, flexShrink: 0 }}>
                    <Typography variant="caption" sx={{ fontSize: 9, color, fontWeight: 700 }}>{label}</Typography>
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
      </Popover>
    </>
  )
}

// ── Observers popover ─────────────────────────────────────────────────────────
function ObsPopover({ packet }: { packet: Packet }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const navigate = useNavigate()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [detail, setDetail] = useState<PacketDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEnter = (e: React.MouseEvent<HTMLElement>) => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setAnchor(e.currentTarget)
    if (!detail && !loading) {
      setLoading(true)
      api.packet(packet.hash).then(d => { setDetail(d); setLoading(false) }).catch(() => setLoading(false))
    }
  }
  const handleLeave = () => { closeTimer.current = setTimeout(() => setAnchor(null), 180) }
  const keepOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current) }

  const obs = deduplicateObs(detail?.observations ?? [])

  return (
    <>
      <Typography
        variant="caption"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        sx={{
          fontSize: 10, color: anchor ? md3.primary : md3.outline,
          cursor: 'default', borderBottom: '1px dashed',
          borderColor: anchor ? md3.primary : 'transparent',
          transition: 'color 0.15s, border-color 0.15s',
        }}
      >
        {packet.obsCount} obs
      </Typography>

      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        disableRestoreFocus
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        sx={{ pointerEvents: 'none' }}
        slotProps={{
          root: { style: { pointerEvents: 'none' } },
          paper: {
            onMouseEnter: keepOpen,
            onMouseLeave: handleLeave,
            style: { pointerEvents: 'auto' },
            sx: {
              mt: 0.5, p: 1.5, borderRadius: 2, minWidth: 200, maxWidth: 320,
              background: md3.surfaceContainerHigh,
              border: `1px solid ${md3.outlineVariant}`,
              boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            },
          },
        }}
      >
        {loading && <Typography variant="caption" sx={{ color: md3.outline }}>Loading…</Typography>}
        {!loading && obs.length === 0 && <Typography variant="caption" sx={{ color: md3.outline }}>No observers</Typography>}
        {!loading && obs.map((o, i) => (
          <Box key={o.id} onClick={() => navigate(`/observers?id=${o.observerId}`)}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: i < obs.length - 1 ? 0.75 : 0, cursor: 'pointer', borderRadius: 1, px: 0.5, '&:hover': { background: alpha(md3.primary, 0.06) } }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, fontSize: 11, display: 'block' }}>
                {o.observerName || o.observerId.slice(0, 16)}
                {o.observerIata && <Box component="span" sx={{ ml: 0.5, color: md3.tertiary }}>{o.observerIata}</Box>}
              </Typography>
              <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>
                {o.snr != null && `SNR ${o.snr.toFixed(1)} dB`}
                {o.snr != null && o.rssi != null && ' · '}
                {o.rssi != null && `${o.rssi.toFixed(0)} dBm`}
              </Typography>
            </Box>
            <Typography variant="caption" sx={{ color: '#22c55e', fontSize: 10, flexShrink: 0 }}>→</Typography>
          </Box>
        ))}
      </Popover>
    </>
  )
}

// ── Channel list with Known / Encrypted sections ─────────────────────────────
function ChannelList({ channels, selected, onSelect, seenCounts }: {
  channels: Channel[]
  selected: Channel | null
  onSelect: (ch: Channel) => void
  seenCounts: Record<string, number>
}) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [encOpen, setEncOpen] = useState(false)

  const isKnown = (ch: Channel) => !/^[0-9a-fA-F]+$/.test(ch.name)
  // Public always first, then alphabetical (case-insensitive)
  const byName = (a: Channel, b: Channel) => {
    const ap = a.name.toLowerCase() === 'public', bp = b.name.toLowerCase() === 'public'
    if (ap !== bp) return ap ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  }

  const known     = channels.filter(isKnown).sort(byName)
  const encrypted = channels.filter(c => !isKnown(c)).sort(byName)

  const getUnread = (ch: Channel) => {
    if (selected?.hash === ch.hash) return 0
    return Math.max(0, ch.messageCount - (seenCounts[ch.hash] ?? 0))
  }

  const renderItem = (ch: Channel) => {
    const unread = getUnread(ch)
    return (
      <ListItemButton key={ch.hash} selected={selected?.hash === ch.hash} onClick={() => onSelect(ch)}
        sx={{ flexDirection: 'column', alignItems: 'flex-start', py: 1, gap: 0.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%' }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: hashColor(ch.name), flexShrink: 0 }} />
          <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {ch.name}
          </Typography>
          {unread > 0 && (
            <Badge badgeContent={unread > 99 ? '99+' : unread} color="primary"
              sx={{ '& .MuiBadge-badge': { position: 'static', transform: 'none', fontSize: 10, minWidth: 18, height: 18, borderRadius: 9 } }} />
          )}
        </Box>
        <Typography variant="caption" sx={{ color: md3.outline, pl: 2 }}>#{ch.hash} · {t('channels.messages', { count: ch.messageCount })}</Typography>
      </ListItemButton>
    )
  }

  if (channels.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="caption" sx={{ color: md3.outline }}>{t('channels.noChannels')}</Typography>
      </Box>
    )
  }

  return (
    <List dense sx={{ flex: 1, overflow: 'auto', py: 0 }}>
      {/* ── Known (decrypted) ── */}
      {known.length > 0 && known.map(renderItem)}

      {/* ── Encrypted section header ── */}
      {encrypted.length > 0 && (
        <>
          {known.length > 0 && <Divider />}
          <ListItemButton onClick={() => setEncOpen(v => !v)}
            sx={{ py: 0.75, gap: 0.75, color: md3.onSurfaceVariant }}>
            <LockIcon sx={{ fontSize: 13, color: md3.outline }} />
            <Typography variant="caption" sx={{ flex: 1, color: md3.outline, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', fontSize: 10 }}>
              {t('channels.encrypted')} ({encrypted.length})
            </Typography>
            <ExpandMoreIcon sx={{ fontSize: 16, color: md3.outline, transition: 'transform 0.2s', transform: encOpen ? 'rotate(180deg)' : 'none' }} />
          </ListItemButton>
          <Collapse in={encOpen}>
            {encrypted.map(renderItem)}
          </Collapse>
        </>
      )}
    </List>
  )
}

// ── Key Manager ───────────────────────────────────────────────────────────────
function KeyManager({ keys, onChange, onClose }: { keys: StoredKey[]; onChange: (k: StoredKey[]) => void; onClose: () => void }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [name, setName]         = useState('')
  const [keyHex, setKeyHex]     = useState('')
  const [isHashtag, setHashtag] = useState(false)
  const [error, setError]       = useState('')
  const [deriving, setDeriving] = useState(false)

  const add = async () => {
    setError('')
    const n = name.trim()
    if (!n) { setError(t('channels.errName')); return }
    let k = keyHex.trim().replace(/\s/g, '')
    if (isHashtag) { setDeriving(true); k = await deriveHashtagKey(n); setDeriving(false) }
    else if (!/^[0-9a-fA-F]{32}$/.test(k)) { setError(t('channels.errKey')); return }
    if (keys.some(x => x.name.toLowerCase() === n.toLowerCase())) { setError(t('channels.errExists')); return }
    onChange([...keys, { name: n, key: k, derived: isHashtag }])
    setName(''); setKeyHex('')
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{t('channels.keyManager')}</Typography>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('channels.keyManagerSub')}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} sx={{ color: md3.onSurfaceVariant }}><CloseIcon fontSize="small" /></IconButton>
      </Box>

      {/* Add form */}
      <Paper elevation={1} sx={{ p: 2, mb: 2, borderRadius: 3 }}>
        <Typography variant="subtitle2" sx={{ color: md3.onSurfaceVariant, mb: 1.5 }}>{t('channels.addKey')}</Typography>
        <FormControlLabel control={<Switch checked={isHashtag} onChange={e => setHashtag(e.target.checked)} size="small" />}
          label={<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><TagIcon sx={{ fontSize: 14 }} /><Typography variant="body2">{t('channels.hashtagToggle')}</Typography></Box>} sx={{ mb: 1.5 }} />
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <TextField label={t('channels.channelName')} size="small" value={name} onChange={e => setName(e.target.value)} placeholder={isHashtag ? '#mychannel' : 'Public'} sx={{ flex: 1, minWidth: 140 }} />
          {!isHashtag && (
            <TextField label={t('channels.aesKey')} size="small" value={keyHex} onChange={e => setKeyHex(e.target.value)}
              placeholder="8b3387e9c5cdea6ac9e5edbaa115cd72" sx={{ flex: 2, minWidth: 200 }}
              slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } }} />
          )}
          <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={add} disabled={deriving} sx={{ alignSelf: 'flex-end' }}>
            {deriving ? t('channels.deriving') : t('channels.add')}
          </Button>
        </Box>
        {error && <Typography variant="caption" sx={{ color: md3.error, display: 'block', mt: 1 }}>{error}</Typography>}
        {isHashtag && (
          <Typography variant="caption" sx={{ color: md3.outline, display: 'block', mt: 1 }}>
            {t('channels.derivedNote')}
          </Typography>
        )}
      </Paper>

      {/* Preset */}
      {!keys.some(k => k.name.toLowerCase() === 'public') && (
        <Paper elevation={1} sx={{ p: 1.5, mb: 2, borderRadius: 3, border: `1px dashed ${md3.outlineVariant}`, display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('channels.builtinPublic')}</Typography>
            <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace' }}>8b3387e9c5cdea6ac9e5edbaa115cd72</Typography>
          </Box>
          <Button size="small" variant="outlined" onClick={() => onChange([...keys, { name: 'Public', key: '8b3387e9c5cdea6ac9e5edbaa115cd72', derived: false }])}>{t('channels.add')}</Button>
        </Paper>
      )}

      {/* Key list */}
      {keys.length === 0
        ? <Typography variant="body2" sx={{ color: md3.outline, textAlign: 'center', py: 3 }}>{t('channels.noKeys')}</Typography>
        : keys.map(k => (
          <Paper key={k.name} elevation={1} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, mb: 1, borderRadius: 3 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: hashColor(k.name), flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>{k.name}</Typography>
                {k.derived && <Chip label={t('channels.hashtag')} size="small" sx={{ fontSize: 10, height: 18, background: alpha('#f59e0b', 0.15), color: '#f59e0b' }} />}
              </Box>
              <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace' }}>{k.key}</Typography>
            </Box>
            <IconButton size="small" onClick={() => onChange(keys.filter(x => x.name !== k.name))} sx={{ color: md3.outline }}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Paper>
        ))
      }
    </Box>
  )
}
