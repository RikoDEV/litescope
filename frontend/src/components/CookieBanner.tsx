import { useState } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import CookieIcon from '@mui/icons-material/Cookie'
import { LS_KEYS } from '../utils/storage'

const LS_KEY = LS_KEYS.cookieConsent

export type CookieConsent = 'all' | 'necessary'

export function getCookieConsent(): CookieConsent | null {
  const v = localStorage.getItem(LS_KEY)
  return v === 'all' || v === 'necessary' ? v : null
}

export default function CookieBanner() {
  const theme = useTheme()
  const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [visible, setVisible] = useState(() => getCookieConsent() === null)

  if (!visible) return null

  const accept = (level: CookieConsent) => {
    localStorage.setItem(LS_KEY, level)
    setVisible(false)
  }

  return (
    <Box sx={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 2000,
      p: { xs: 1, sm: 2 },
      pointerEvents: 'none',
    }}>
      <Paper elevation={8} sx={{
        maxWidth: 680, mx: 'auto',
        p: { xs: 2, sm: 2.5 },
        borderRadius: 3,
        background: md3.surfaceContainerHigh,
        border: `1px solid ${md3.outlineVariant}`,
        backdropFilter: 'blur(12px)',
        pointerEvents: 'all',
        display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, alignItems: { sm: 'center' },
      }}>
        {/* Icon */}
        <Box sx={{
          width: 40, height: 40, borderRadius: 2, flexShrink: 0,
          background: alpha(md3.primary, 0.12),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <CookieIcon sx={{ fontSize: 22, color: md3.primary }} />
        </Box>

        {/* Text */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.25 }}>
            {t('cookie.title')}
          </Typography>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block' }}>
            {t('cookie.body')}
          </Typography>
        </Box>

        {/* Actions */}
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
          <Button size="small" variant="outlined" onClick={() => accept('necessary')}
            sx={{ borderColor: md3.outline, color: md3.onSurfaceVariant, fontSize: 12, whiteSpace: 'nowrap' }}>
            {t('cookie.acceptNecessary')}
          </Button>
          <Button size="small" variant="contained" onClick={() => accept('all')}
            sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {t('cookie.acceptAll')}
          </Button>
        </Box>
      </Paper>
    </Box>
  )
}
