import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import HomeIcon from '@mui/icons-material/Home'
import WifiTetheringErrorIcon from '@mui/icons-material/WifiTetheringError'

export default function NotFound() {
  const theme = useTheme()
  const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 3, background: md3.background, px: 3, textAlign: 'center',
    }}>
      <WifiTetheringErrorIcon sx={{ fontSize: 80, color: md3.outline, opacity: 0.4 }} />

      <Box>
        <Typography variant="h1" sx={{
          fontSize: '6rem', fontWeight: 900, lineHeight: 1,
          color: md3.primary, opacity: 0.15, userSelect: 'none',
        }}>
          404
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 700, color: md3.onSurface, mt: -1 }}>
          {t('notFound.title')}
        </Typography>
        <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, mt: 1, maxWidth: 380 }}>
          {t('notFound.subtitle')}
        </Typography>
      </Box>

      <Button
        variant="contained"
        startIcon={<HomeIcon />}
        onClick={() => navigate('/', { replace: true })}
        sx={{
          background: md3.primary, color: md3.onPrimary,
          borderRadius: 3, px: 3, py: 1,
          '&:hover': { background: md3.primaryContainer, color: md3.onPrimaryContainer },
        }}
      >
        {t('notFound.goHome')}
      </Button>
    </Box>
  )
}
