import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import CircularProgress from '@mui/material/CircularProgress'
import { useTheme } from '@mui/material/styles'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { api } from '../services/api'
import type { Node, NodeOverview, RFStats } from '../types'
import NodeDetailPanel from '../components/NodeDetailPanel'

export default function NodePage() {
  const { pubkey } = useParams<{ pubkey: string }>()
  const navigate    = useNavigate()
  const theme       = useTheme(); const md3 = theme.palette.md3

  const [node,     setNode]     = useState<Node | null>(null)
  const [overview, setOverview] = useState<NodeOverview | null>(null)
  const [rf,       setRF]       = useState<RFStats | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(false)

  useEffect(() => {
    if (!pubkey) return
    api.nodes().then(res => {
      const n = (res.nodes ?? []).find(x => x.pubKey === pubkey)
      if (!n) { setError(true); setLoading(false); return }
      setNode(n)
      document.title = `${n.name || n.pubKey.slice(0, 16)} — liteScope`
      Promise.all([api.nodeOverview(pubkey), api.nodeRF(pubkey)])
        .then(([ov, rfData]) => { setOverview(ov); setRF(rfData) })
        .finally(() => setLoading(false))
    }).catch(() => { setError(true); setLoading(false) })
  }, [pubkey])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={32} />
      </Box>
    )
  }

  if (error || !node) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
        <Typography variant="body1" sx={{ color: md3.onSurfaceVariant }}>Node not found</Typography>
        <IconButton onClick={() => navigate(-1)}><ArrowBackIcon /></IconButton>
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', background: md3.background, display: 'flex', justifyContent: 'center' }}>
      {/* NodeDetailPanel without onClose renders as a proper page — no close button, no box borders */}
      <NodeDetailPanel
        selected={node}
        overview={overview}
        rf={rf}
        paperSx={{
          width: '100%', maxWidth: 700,
          borderLeft: 'none', borderRight: 'none',
          borderRadius: 0, flexShrink: 0,
          boxShadow: 'none', elevation: 0,
        }}
      />
    </Box>
  )
}
