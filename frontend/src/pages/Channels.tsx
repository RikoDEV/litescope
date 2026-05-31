import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Avatar from '@mui/material/Avatar'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Divider from '@mui/material/Divider'
import Switch from '@mui/material/Switch'
import FormControlLabel from '@mui/material/FormControlLabel'
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import KeyIcon from '@mui/icons-material/Key'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import TagIcon from '@mui/icons-material/Tag'
import CloseIcon from '@mui/icons-material/Close'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { api } from '../services/api'
import { stream } from '../services/stream'
import type { Channel, Packet } from '../types'
import { formatDistanceToNow } from 'date-fns'

// ── channel key storage ───────────────────────────────────────────────────────
const LS_KEY = 'litescope-channel-keys'
interface StoredKey { name: string; key: string; derived: boolean }

function loadKeys(): StoredKey[] { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') } catch { return [] } }
function saveKeys(k: StoredKey[]) { localStorage.setItem(LS_KEY, JSON.stringify(k)) }

async function deriveHashtagKey(name: string): Promise<string> {
  const n = name.startsWith('#') ? name : '#' + name
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n))
  return Array.from(new Uint8Array(digest)).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function tryDecrypt(encHex: string, macHex: string, keyHex: string): Promise<{ sender: string; text: string } | null> {
  try {
    const key   = hexToBytes(keyHex)
    const mac   = hexToBytes(macHex)
    const ct    = hexToBytes(encHex)
    if (key.length !== 16 || mac.length !== 2 || ct.length === 0 || ct.length % 16 !== 0) return null
    const secret = new Uint8Array(32); secret.set(key)
    const hmacKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ct))
    if (sig[0] !== mac[0] || sig[1] !== mac[1]) return null
    const ck  = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt'])
    const iv  = new Uint8Array(16)
    const plain = new Uint8Array(ct.length)
    for (let i = 0; i < ct.length; i += 16) {
      const blk = new Uint8Array(32); blk.set(ct.slice(i, i + 16), 16)
      plain.set(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, blk)).slice(0, 16), i)
    }
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

function hashColor(s: string) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff
  return `hsl(${h % 360}, 65%, 55%)`
}

// ── component ────────────────────────────────────────────────────────────────
export default function Channels() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [channels, setChannels]     = useState<Channel[]>([])
  const [selected, setSelected]     = useState<Channel | null>(null)
  const [messages, setMessages]     = useState<Packet[]>([])
  const [showKeyMgr, setShowKeyMgr] = useState(false)
  const [decrypted, setDecrypted]   = useState<Record<number, { sender: string; text: string }>>({})
  const [storedKeys, setStoredKeys] = useState<StoredKey[]>(loadKeys)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { api.channels().then(setChannels) }, [])

  const selectChannel = async (ch: Channel) => {
    setSelected(ch); setDecrypted({})
    const msgs = await api.channelMessages(ch.hash); setMessages(msgs)
    decryptBatch(msgs, storedKeys)
  }

  const decryptBatch = async (msgs: Packet[], keys: StoredKey[]) => {
    const updates: Record<number, { sender: string; text: string }> = {}
    for (const msg of msgs) {
      const d = msg.decoded
      if (!d || d.decryptionStatus !== 'no_key') continue
      const mac = d.mac as string | undefined; const enc = d.encryptedData as string | undefined
      if (!mac || !enc) continue
      for (const k of keys) {
        const r = await tryDecrypt(enc, mac, k.key)
        if (r) { updates[msg.id] = r; break }
      }
    }
    if (Object.keys(updates).length > 0) setDecrypted(p => ({ ...p, ...updates }))
  }

  useEffect(() => {
    const unsub = stream.subscribe(async msg => {
      if (msg.type !== 'packet') return
      const d = msg.data.decoded
      if (!d || (d.decryptionStatus !== 'decrypted' && d.decryptionStatus !== 'no_key')) return
      if (selected && msg.data.channelHash === selected.hash) {
        setMessages(p => [msg.data, ...p])
        if (d.decryptionStatus === 'no_key') decryptBatch([msg.data], storedKeys)
      }
      setChannels(prev => {
        const idx = prev.findIndex(c => c.hash === msg.data.channelHash)
        if (idx >= 0) { const n = [...prev]; n[idx] = { ...n[idx], messageCount: n[idx].messageCount + 1 }; return n }
        return [...prev, { hash: msg.data.channelHash ?? '', name: (d.channel as string) ?? msg.data.channelHash ?? 'Unknown', messageCount: 1 }]
      })
    })
    return unsub
  }, [selected, storedKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  const persistKeys = (k: StoredKey[]) => { setStoredKeys(k); saveKeys(k) }

  return (
    <Box sx={{ display: 'flex', height: '100%', background: md3.background }}>
      {/* ── Channel list ── */}
      <Paper elevation={1} sx={{ width: 220, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${md3.outlineVariant}`, borderRadius: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1, borderBottom: `1px solid ${md3.outlineVariant}` }}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>{t('channels.count', { count: channels.length })}</Typography>
          <Tooltip title={t('channels.manageKeys')}>
            <IconButton size="small" onClick={() => setShowKeyMgr(v => !v)} sx={{ color: showKeyMgr ? md3.primary : md3.onSurfaceVariant }}>
              <KeyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto', py: 0 }}>
          {channels.map(ch => (
            <ListItemButton key={ch.hash} selected={selected?.hash === ch.hash} onClick={() => selectChannel(ch)} sx={{ flexDirection: 'column', alignItems: 'flex-start', py: 1, gap: 0.25 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%' }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: hashColor(ch.name), flexShrink: 0 }} />
                <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{ch.name}</Typography>
              </Box>
              <Typography variant="caption" sx={{ color: md3.outline, pl: 2 }}>#{ch.hash} · {ch.messageCount}</Typography>
            </ListItemButton>
          ))}
          {channels.length === 0 && (
            <Box sx={{ p: 2 }}>
              <Typography variant="caption" sx={{ color: md3.outline }}>{t('channels.noChannels')}</Typography>
            </Box>
          )}
        </List>
      </Paper>

      {/* ── Main ── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {showKeyMgr ? (
          <KeyManager keys={storedKeys} onChange={persistKeys} onClose={() => setShowKeyMgr(false)} />
        ) : selected ? (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, borderBottom: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow, flexShrink: 0 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: hashColor(selected.name) }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{selected.name}</Typography>
              <Typography variant="caption" sx={{ color: md3.outline }}>#{selected.hash}</Typography>
              <Typography variant="caption" sx={{ color: md3.outline, ml: 'auto' }}>{t('channels.messages', { count: messages.length })}</Typography>
            </Box>
            <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {[...messages].reverse().map(msg => {
                const dec    = msg.decoded
                const cdec   = decrypted[msg.id]
                const noKey  = dec?.decryptionStatus === 'no_key' && !cdec
                const sender = cdec?.sender || (dec?.sender as string) || 'Unknown'
                const rawT   = cdec?.text || (dec?.text as string) || ''
                const text   = rawT.startsWith(sender + ': ') ? rawT.slice(sender.length + 2) : rawT
                return (
                  <Box key={msg.id} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', opacity: noKey ? 0.5 : 1 }}>
                    <Avatar sx={{ width: 34, height: 34, background: hashColor(sender), fontSize: 14, fontWeight: 700 }}>
                      {sender[0]?.toUpperCase() ?? '?'}
                    </Avatar>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.25, flexWrap: 'wrap' }}>
                        <Typography variant="body2" sx={{ fontWeight: 700, color: hashColor(sender) }}>{sender}</Typography>
                        <Typography variant="caption" sx={{ color: md3.outline }}>
                          {formatDistanceToNow(new Date(msg.firstSeen), { addSuffix: true })}
                        </Typography>
                        {noKey && <Chip label={`🔒 ${t('channels.encrypted')}`} size="small" sx={{ fontSize: 10, height: 18, background: alpha('#f59e0b', 0.15), color: '#f59e0b' }} />}
                        {cdec && <Chip label={`🔓 ${t('channels.decrypted')}`} size="small" sx={{ fontSize: 10, height: 18, background: alpha('#22c55e', 0.15), color: '#22c55e' }} />}
                        <Box sx={{ display: 'flex', gap: 0.5, ml: 'auto', alignItems: 'center' }}>
                          {msg.obsCount > 0 && (
                            <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>
                              {msg.obsCount} obs
                            </Typography>
                          )}
                          {msg.maxHops > 0 && (
                            <Typography variant="caption" sx={{ color: md3.outline, fontSize: 10 }}>
                              · {msg.maxHops} hops
                            </Typography>
                          )}
                          <Tooltip title="View packet">
                            <IconButton size="small" onClick={() => navigate(`/packets?hash=${msg.hash}`)}
                              sx={{ color: md3.outline, p: 0.25, '&:hover': { color: md3.primary } }}>
                              <OpenInNewIcon sx={{ fontSize: 13 }} />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </Box>
                      {noKey
                        ? <Typography variant="caption" sx={{ color: md3.outline, fontFamily: 'monospace' }}>{(dec?.encryptedData as string | undefined)?.slice(0, 40) ?? ''}…</Typography>
                        : <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{text}</Typography>
                      }
                    </Box>
                  </Box>
                )
              })}
              <div ref={bottomRef} />
            </Box>
          </>
        ) : (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, color: md3.onSurfaceVariant }}>
            <KeyIcon sx={{ fontSize: 48, opacity: 0.4 }} />
            <Typography variant="body1">{t('channels.selectChannel')}</Typography>
            <Button variant="outlined" size="small" onClick={() => setShowKeyMgr(true)}>{t('channels.manageKeys')}</Button>
          </Box>
        )}
      </Box>
    </Box>
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
