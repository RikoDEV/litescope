import { Component, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import ErrorOutlineIcon from '@mui/icons-material/ReportProblem'
import HomeIcon from '@mui/icons-material/Home'
import RefreshIcon from '@mui/icons-material/Refresh'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import BugReportIcon from '@mui/icons-material/BugReport'
import { buildIssueUrl } from '../utils/issueUrl'

// ── Page-level error fallback (uses MUI — only safe inside ThemeModeProvider) ──
function PageErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const theme = useTheme()
  const md3   = theme.palette.md3
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const errorText = `${error.name}: ${error.message}\n\n${error.stack ?? ''}`

  const copy = () => {
    navigator.clipboard.writeText(errorText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 3, background: md3.background, px: 3, textAlign: 'center',
    }}>
      <ErrorOutlineIcon sx={{ fontSize: 80, color: md3.error, opacity: 0.35 }} />

      <Box>
        <Typography variant="h1" sx={{
          fontSize: '5rem', fontWeight: 900, lineHeight: 1,
          color: md3.error, opacity: 0.12, userSelect: 'none',
        }}>
          500
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 700, color: md3.onSurface, mt: -1 }}>
          {t('error.title')}
        </Typography>
        <Typography variant="body2" sx={{ color: md3.onSurfaceVariant, mt: 1, maxWidth: 420 }}>
          {t('error.subtitle')}
        </Typography>
      </Box>

      {/* Error details */}
      <Box sx={{
        maxWidth: 560, width: '100%',
        background: alpha(md3.error, 0.06),
        border: `1px solid ${alpha(md3.error, 0.2)}`,
        borderRadius: 2, px: 2, py: 1.5, textAlign: 'left',
      }}>
        <Typography variant="caption" sx={{
          fontFamily: 'monospace', fontSize: 11, color: md3.error,
          display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          maxHeight: 120, overflow: 'auto',
        }}>
          {error.name}: {error.message}
        </Typography>
      </Box>

      {/* Actions */}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={copy}
          size="small" sx={{ borderColor: md3.outline, color: md3.onSurfaceVariant }}>
          {copied ? t('error.copied') : t('error.copyError')}
        </Button>
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={reset}
          size="small" sx={{ borderColor: md3.outline, color: md3.onSurfaceVariant }}>
          {t('error.reload')}
        </Button>
        <Button variant="outlined" startIcon={<BugReportIcon />}
          size="small" href={buildIssueUrl(error)} target="_blank" rel="noopener noreferrer"
          component="a" sx={{ borderColor: md3.error, color: md3.error }}>
          {t('error.reportIssue')}
        </Button>
        <Button variant="contained" startIcon={<HomeIcon />}
          onClick={() => { window.location.href = '/' }}
          sx={{ background: md3.primary, color: md3.onPrimary, borderRadius: 3 }}>
          {t('error.goHome')}
        </Button>
      </Box>
    </Box>
  )
}

// ── Minimal top-level fallback (no MUI — safe when providers may be broken) ──
function AppErrorFallback({ error }: { error: Error }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', gap: 24, fontFamily: 'system-ui, sans-serif', padding: '0 24px',
      background: '#0f0f0f', color: '#e0e0e0', textAlign: 'center',
    }}>
      <div style={{ fontSize: 64, opacity: 0.3 }}>⚠</div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Something went wrong</div>
        <div style={{ fontSize: 14, color: '#999', maxWidth: 400 }}>
          liteScope failed to start. Try reloading the page.
        </div>
      </div>
      <div style={{
        background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
        padding: '12px 16px', maxWidth: 560, width: '100%', textAlign: 'left',
      }}>
        <code style={{ fontSize: 11, color: '#f87171', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {error.name}: {error.message}
        </code>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={() => window.location.reload()}
          style={{
            background: '#6750a4', color: '#fff', border: 'none', borderRadius: 8,
            padding: '10px 24px', fontSize: 14, cursor: 'pointer', fontWeight: 600,
          }}>
          Reload page
        </button>
        <a href={buildIssueUrl(error)} target="_blank" rel="noopener noreferrer"
          style={{
            background: 'transparent', color: '#f87171', border: '1px solid #f87171',
            borderRadius: 8, padding: '10px 24px', fontSize: 14, cursor: 'pointer',
            fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
          }}>
          Report issue
        </a>
      </div>
    </div>
  )
}

// ── Error boundary class ──────────────────────────────────────────────────────
interface Props {
  children: ReactNode
  /** 'page' renders with MUI (inside providers). 'app' uses plain HTML fallback. */
  level?: 'page' | 'app'
}

interface State {
  error: Error | null
  key: number
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  reset = () => this.setState(s => ({ error: null, key: s.key + 1 }))

  override render() {
    const { error, key } = this.state
    const { level = 'page' } = this.props

    if (error) {
      return level === 'app'
        ? <AppErrorFallback error={error} />
        : <PageErrorFallback error={error} reset={this.reset} />
    }

    // key change forces a full subtree remount on reset
    return <div key={key} style={{ display: 'contents' }}>{this.props.children}</div>
  }
}
