import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import CircularProgress from '@mui/material/CircularProgress'
import { useTheme } from '@mui/material/styles'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { api } from '../services/api'
import type { PacketDetail } from '../types'
import PacketDetailPanel from '../components/PacketDetailPanel'

export default function PacketPage() {
  const { hash } = useParams<{ hash: string }>()
  const navigate  = useNavigate()
  const theme     = useTheme(); const md3 = theme.palette.md3

  const [detail,  setDetail]  = useState<PacketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    if (!hash) return
    api.packet(hash)
      .then(d => {
        setDetail(d)
        const label = (d.decoded?.name ?? d.decoded?.sender ?? hash?.slice(0, 12)) as string
        document.title = `${label} — liteScope`
        setLoading(false)
      })
      .catch(() => { setError(true); setLoading(false) })
  }, [hash])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={32} />
      </Box>
    )
  }

  if (error || !detail) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
        <Typography variant="body1" sx={{ color: md3.onSurfaceVariant }}>Packet not found</Typography>
        <IconButton onClick={() => navigate(-1)}><ArrowBackIcon /></IconButton>
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', background: md3.background }}>
      {/* Back header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75, borderBottom: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow, flexShrink: 0 }}>
        <IconButton size="small" onClick={() => navigate(-1)} sx={{ color: md3.onSurfaceVariant }}>
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: md3.outline }}>{hash}</Typography>
      </Box>

      {/* Panel — full width, centered, no side-panel constraints */}
      <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center' }}>
        <PacketDetailPanel
          selected={detail}
          onClose={() => navigate(-1)}
          paperSx={{
            width: '100%', maxWidth: 640, borderLeft: 'none', borderRight: 'none',
            borderRadius: 0, flexShrink: 0,
          }}
        />
      </Box>
    </Box>
  )
}
