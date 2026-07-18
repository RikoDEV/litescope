import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ShieldIcon from '@mui/icons-material/Shield'
import { getEnv } from '../env'
import { parseMarkdownLite, type MarkdownBlock } from '../utils/markdownLite'

// Instance operators can drop a privacy.md at the web root (mounted over the
// static frontend, e.g. via a Docker volume) to fully replace the built-in
// policy below with their own — no rebuild required.
function CustomPolicy({ blocks, md3 }: { blocks: MarkdownBlock[]; md3: Record<string, string> }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3') {
          return (
            <Typography key={i} variant={block.type === 'h1' ? 'h6' : 'subtitle1'}
              sx={{ fontWeight: 700, color: md3.onSurface, mt: block.type === 'h1' ? 3 : 2.5, mb: 0.5 }}>
              {block.text}
            </Typography>
          )
        }
        if (block.type === 'ul') {
          return (
            <Box key={i} component="ul" sx={{ m: 0, mb: 2, pl: 3, color: md3.onSurfaceVariant }}>
              {block.items.map((item, j) => (
                <Typography key={j} component="li" variant="body2" sx={{ color: 'inherit', mb: 0.25 }}>
                  {item}
                </Typography>
              ))}
            </Box>
          )
        }
        return (
          <Typography key={i} variant="body2" sx={{ color: md3.onSurfaceVariant, mb: 2 }}>
            {block.text}
          </Typography>
        )
      })}
    </>
  )
}

export default function PrivacyPolicy() {
  const theme = useTheme()
  const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [customBlocks, setCustomBlocks] = useState<MarkdownBlock[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/privacy.md', { cache: 'no-store' })
      .then(res => {
        // SPA hosting (nginx try_files, Cloudflare Pages _redirects) serves
        // index.html with a 200 for any unknown path, so a missing privacy.md
        // resolves "ok" too — a real .md response is never text/html.
        const contentType = res.headers.get('content-type') ?? ''
        if (!res.ok || contentType.includes('html')) return ''
        return res.text()
      })
      .then(text => {
        const trimmed = text.trim()
        if (!cancelled && trimmed && !/^<(!doctype|html)/i.test(trimmed)) {
          setCustomBlocks(parseMarkdownLite(trimmed))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const usesUmami = Boolean(getEnv('VITE_UMAMI_URL') && getEnv('VITE_UMAMI_WEBSITE_ID'))
  const sections = t('privacy.sections', { returnObjects: true }) as { heading: string; body: string }[]
  const beforeAnalytics = sections.slice(0, 3)
  const afterAnalytics = sections.slice(3)

  return (
    <Box sx={{
      height: '100%', overflowY: 'auto', background: md3.background,
      display: 'flex', justifyContent: 'center', px: { xs: 2, md: 3 }, py: { xs: 3, md: 4 },
    }}>
      <Box sx={{ maxWidth: 760, width: '100%' }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate(-1)}
          sx={{ color: md3.onSurfaceVariant, mb: 2, textTransform: 'none' }}
        >
          {t('common.back')}
        </Button>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
          <ShieldIcon sx={{ fontSize: 28, color: md3.primary }} />
          <Typography variant="h5" sx={{ fontWeight: 700, color: md3.onSurface }}>
            {t('privacy.title')}
          </Typography>
        </Box>

        {customBlocks ? (
          <>
            <Typography variant="caption" sx={{ display: 'block', color: md3.onSurfaceVariant, mb: 2 }}>
              {t('privacy.customNotice')}
            </Typography>
            <CustomPolicy blocks={customBlocks} md3={md3} />
          </>
        ) : (
          <>
            {beforeAnalytics.map((section, i) => (
              <Box key={i} sx={{ mb: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, color: md3.onSurface, mb: 0.5 }}>
                  {section.heading}
                </Typography>
                <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, whiteSpace: 'pre-line' }}>
                  {section.body}
                </Typography>
              </Box>
            ))}

            <Box sx={{ mb: 2.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, color: md3.onSurface, mb: 0.5 }}>
                {t('privacy.analyticsHeading')}
              </Typography>
              <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, whiteSpace: 'pre-line' }}>
                {usesUmami ? t('privacy.analyticsUmami') : t('privacy.analyticsNone')}
              </Typography>
            </Box>

            {afterAnalytics.map((section, i) => (
              <Box key={i} sx={{ mb: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, color: md3.onSurface, mb: 0.5 }}>
                  {section.heading}
                </Typography>
                <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, whiteSpace: 'pre-line' }}>
                  {section.body}
                </Typography>
              </Box>
            ))}
          </>
        )}
      </Box>
    </Box>
  )
}
