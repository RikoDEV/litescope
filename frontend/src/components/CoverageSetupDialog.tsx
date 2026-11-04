import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import SensorsIcon from '@mui/icons-material/Sensors'
import CopyField from './CopyField'
import { getEnv } from '../env'
import { LS_KEYS } from '../utils/storage'

const MESHMAPPER_PLAY_URL = 'https://play.google.com/store/apps/details?id=net.meshmapper.app'

// MeshMapper stores the Custom API URL without a scheme and always prepends
// https://, so the guide shows host + path only. VITE_API_URL (when the API
// lives on another origin, e.g. Cloudflare Pages) wins over the page's host.
export function wardriveEndpoint(): string {
  const base = getEnv('VITE_API_URL').trim()
  let host = window.location.host
  if (/^https?:\/\//i.test(base)) {
    try { host = new URL(base).host } catch { /* keep page host */ }
  }
  return `${host}/api/wardrive`
}

export function hasSeenCoverageGuide(): boolean {
  try { return localStorage.getItem(LS_KEYS.coverageGuideSeen) === '1' } catch { return false }
}

export function markCoverageGuideSeen(): void {
  try { localStorage.setItem(LS_KEYS.coverageGuideSeen, '1') } catch { /* private mode: show again next time */ }
}

interface Props {
  open: boolean
  onClose: () => void
  // false → the instance has wardrive collection turned off; undefined → not known yet.
  enabled?: boolean | undefined
}

// First-run guide for the /map coverage layer: how to point the MeshMapper
// app's Custom API at this instance. Mirrors the observers MQTT setup card.
export default function CoverageSetupDialog({ open, onClose, enabled }: Props) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()

  const endpoint = wardriveEndpoint()
  const apiKey = 'litescope'
  const setupLink = `meshmapper://custom-api?url=${encodeURIComponent(endpoint)}&key=${encodeURIComponent(apiKey)}`
  const steps = [t('map.coverageGuideStep1'), t('map.coverageGuideStep2'), t('map.coverageGuideStep3'), t('map.coverageGuideStep4')]

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="coverage-guide-title">
      <DialogTitle id="coverage-guide-title" sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <SensorsIcon sx={{ color: md3.primary, fontSize: 20 }} />
        {/* Block-level spans: DialogTitle is an <h2> (no nested headings), and an
            inline caption would inherit its tall line box, opening a gap. */}
        <Box sx={{ lineHeight: 1 }}>
          <Typography component="span" variant="subtitle1" sx={{ display: 'block', fontWeight: 700, lineHeight: 1.3 }}>{t('map.coverageGuideTitle')}</Typography>
          <Typography component="span" variant="caption" sx={{ display: 'block', mt: 0.25, lineHeight: 1.4, color: md3.onSurfaceVariant }}>{t('map.coverageGuideSub')}</Typography>
        </Box>
      </DialogTitle>

      <DialogContent dividers sx={{ background: md3.surfaceContainerLowest }}>
        {enabled === false && (
          <Box sx={{
            mb: 2, px: 1.5, py: 1, borderRadius: 1.5, display: 'flex', gap: 1,
            background: alpha('#f59e0b', 0.08), border: `1px solid ${alpha('#f59e0b', 0.35)}`,
          }}>
            <WarningAmberIcon sx={{ fontSize: 16, color: '#f59e0b', flexShrink: 0, mt: 0.2 }} />
            <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, lineHeight: 1.55 }}>
              {t('map.coverageGuideDisabled')}
            </Typography>
          </Box>
        )}

        <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mb: 1 }}>{t('observers.setupSteps')}</Typography>
        {steps.map((s, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1.25, mb: 1.25 }}>
            <Box sx={{
              width: 20, height: 20, borderRadius: '50%', flexShrink: 0, mt: 0.15,
              background: alpha(md3.primary, 0.15),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Typography sx={{ fontSize: 10, fontWeight: 700, color: md3.primary, lineHeight: 1 }}>{i + 1}</Typography>
            </Box>
            <Typography variant="body2" sx={{ color: md3.onSurface, lineHeight: 1.5 }}>{s}</Typography>
          </Box>
        ))}

        <Typography variant="overline" sx={{ color: md3.outline, fontSize: 9, display: 'block', mt: 1.5, mb: 0.5 }}>{t('map.coverageGuideDetails')}</Typography>
        <CopyField label={t('map.coverageGuideEndpoint')} value={endpoint} labelWidth={90} />
        <CopyField label={t('map.coverageGuideApiKey')} value={apiKey} labelWidth={90} />
        <CopyField label={t('map.coverageGuideLink')} value={setupLink} labelWidth={90} />
        <Typography variant="caption" sx={{ color: md3.outline, display: 'block', mt: 0.5, lineHeight: 1.5 }}>
          {t('map.coverageGuideKeyNote')}
        </Typography>

        <Box sx={{
          mt: 2, px: 1.5, py: 1, borderRadius: 1.5, display: 'flex', gap: 1,
          background: alpha(md3.primary, 0.06), border: `1px solid ${alpha(md3.primary, 0.2)}`,
        }}>
          <InfoOutlinedIcon sx={{ fontSize: 15, color: md3.primary, flexShrink: 0, mt: 0.2 }} />
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, lineHeight: 1.55 }}>
            {t('map.coverageGuideLegend')} {t('map.coverageGuidePrivacy')}
          </Typography>
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 2.5, py: 1.5, gap: 1, flexWrap: 'wrap' }}>
        <Button size="small" href={MESHMAPPER_PLAY_URL} target="_blank" rel="noopener noreferrer">{t('map.coverageGuideGetApp')}</Button>
        <Button size="small" href={setupLink}>{t('map.coverageGuideOpenApp')}</Button>
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" onClick={onClose} disableElevation>{t('map.coverageGuideGotIt')}</Button>
      </DialogActions>
    </Dialog>
  )
}
