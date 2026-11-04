import { useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'

// Labelled monospace value with a copy-to-clipboard button, used by the
// observer MQTT setup card and the wardrive coverage setup guide.
export default function CopyField({ label, value, labelWidth = 80 }: { label: string; value: string; labelWidth?: number }) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    })
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Typography variant="caption" sx={{ color: md3.outline, width: labelWidth, flexShrink: 0 }}>{label}</Typography>
      <Box sx={{
        flex: 1, display: 'flex', alignItems: 'center', gap: 0.75,
        px: 1.25, py: 0.4, borderRadius: 1.5,
        background: alpha(md3.surfaceContainerHighest, 0.8),
        border: `1px solid ${alpha(md3.outlineVariant, 0.5)}`,
        fontFamily: 'monospace', fontSize: 12, color: md3.onSurface, minWidth: 0,
      }}>
        <Box sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</Box>
        <Tooltip title={copied ? t('decoder.copied') : t('decoder.copy')}>
          <IconButton size="small" onClick={copy} sx={{ p: 0.25, color: copied ? '#22c55e' : md3.outline, flexShrink: 0 }}>
            {copied ? <CheckIcon sx={{ fontSize: 13 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  )
}
