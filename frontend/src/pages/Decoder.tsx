import { useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Paper from '@mui/material/Paper'
import Alert from '@mui/material/Alert'
import IconButton from '@mui/material/IconButton'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'
import { api } from '../services/api'

const EXAMPLES = [
  { label: 'ADVERT', hex: '04014c35b8e3e4cd26a7f3d5b8f7c6b9a3d1e5f8b2c4a6d8e0f2b4c6a8d0e2f4b6c8daabbcdef012345678910111213141516171819202122232425262728293031323334353637383940414243444546474849505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f70' },
  { label: 'GRP_TXT', hex: '14113a5b2c9d4e8f1a2b3c4d5e6f7081' },
]

export default function Decoder() {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [hex, setHex]       = useState('')
  const [result, setResult] = useState<{ ok: boolean; error?: string; decoded?: unknown } | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const decode = async () => {
    const h = hex.replace(/\s/g, '')
    if (!h) return
    setLoading(true); setResult(null)
    try { setResult(await api.decodePacket(h)) }
    catch (e) { setResult({ ok: false, error: String(e) }) }
    finally { setLoading(false) }
  }

  const copy = () => {
    if (!result) return
    navigator.clipboard.writeText(JSON.stringify(result.decoded ?? result, null, 2))
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  const formatted = result?.decoded ? JSON.stringify(result.decoded, null, 2) : null

  return (
    <Box sx={{ p: 3, maxWidth: 860, height: '100%', overflowY: 'auto', background: md3.background }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>{t('decoder.title')}</Typography>
      <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, mb: 3 }}>
        {t('decoder.subtitle')}
      </Typography>

      {/* Input */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
          <Typography variant="subtitle2" sx={{ color: md3.onSurfaceVariant }}>{t('decoder.rawHex')}</Typography>
          <Box sx={{ display: 'flex', gap: 0.75 }}>
            {EXAMPLES.map(ex => (
              <Button key={ex.label} size="small" variant="outlined" onClick={() => setHex(ex.hex)} sx={{ fontSize: 11, py: 0.25 }}>{ex.label}</Button>
            ))}
          </Box>
        </Box>
        <TextField
          multiline minRows={3} maxRows={6} fullWidth
          value={hex} onChange={e => setHex(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) decode() }}
          placeholder={t('decoder.placeholder')}
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 } } }}
        />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={decode} disabled={!hex.trim() || loading}>
          {loading ? t('decoder.decoding') : t('decoder.decode')}
        </Button>
        <Typography variant="caption" sx={{ color: md3.outline }}>{t('decoder.orCtrlEnter')}</Typography>
      </Box>

      {/* Result */}
      {result && (
        <>
          {result.ok ? (
            <>
              {result.decoded && <DecodedChips decoded={result.decoded as Record<string, unknown>} />}
              <Paper elevation={2} sx={{ position: 'relative', mt: 1, borderRadius: 3 }}>
                <IconButton size="small" onClick={copy} sx={{ position: 'absolute', top: 8, right: 8, color: copied ? '#22c55e' : md3.onSurfaceVariant }}>
                  {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
                </IconButton>
                <Box component="pre" sx={{ p: 2, m: 0, overflow: 'auto', fontSize: 12, fontFamily: 'monospace', color: md3.primary, lineHeight: 1.6, borderRadius: 3 }}>
                  {formatted}
                </Box>
              </Paper>
            </>
          ) : (
            <Alert severity="error" sx={{ borderRadius: 3 }}>
              <strong>{t('decoder.decodeError')}</strong>{result.error}
            </Alert>
          )}
        </>
      )}
    </Box>
  )
}

function DecodedChips({ decoded: d }: { decoded: Record<string, unknown> }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const hdr  = d.header  as Record<string, string | number> | undefined
  const path = d.path    as Record<string, number>          | undefined
  const pl   = d.payload as Record<string, unknown>         | undefined
  const chips: { color: string; label: string; value: string }[] = []
  if (hdr?.routeTypeName)   chips.push({ color: md3.tertiary, label: 'Route', value: String(hdr.routeTypeName) })
  if (hdr?.payloadTypeName) chips.push({ color: md3.primary,  label: 'Type',  value: String(hdr.payloadTypeName) })
  if (hdr?.payloadVersion != null) chips.push({ color: md3.outline, label: 'Ver', value: String(hdr.payloadVersion) })
  if (path?.hashCount && path.hashCount > 0) chips.push({ color: '#22c55e', label: 'Hops', value: `${path.hashCount} × ${path.hashSize}B` })
  if (pl?.pubKey)  chips.push({ color: md3.primary, label: 'PubKey', value: String(pl.pubKey).slice(0, 16) + '…' })
  if (pl?.name)    chips.push({ color: '#f59e0b', label: 'Name',    value: String(pl.name) })
  if (pl?.lat != null && pl?.lon != null) chips.push({ color: '#22c55e', label: 'GPS', value: `${(pl.lat as number).toFixed(4)}, ${(pl.lon as number).toFixed(4)}` })
  if (pl?.channel) chips.push({ color: md3.tertiary, label: 'Channel', value: String(pl.channel) })
  if (pl?.sender)  chips.push({ color: md3.tertiary, label: 'Sender',  value: String(pl.sender) })
  if (!chips.length) return null
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
      {chips.map(c => (
        <Box key={c.label} sx={{ display: 'flex', borderRadius: 2, overflow: 'hidden', fontSize: 12, border: `1px solid ${alpha(c.color, 0.35)}` }}>
          <Box sx={{ background: alpha(c.color, 0.15), color: c.color, px: 1, py: 0.25, fontWeight: 700 }}>{c.label}</Box>
          <Box sx={{ px: 1, py: 0.25, background: alpha(c.color, 0.05) }}>{c.value}</Box>
        </Box>
      ))}
    </Box>
  )
}
