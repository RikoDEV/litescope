import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import CircularProgress from '@mui/material/CircularProgress'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Tooltip from '@mui/material/Tooltip'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemText from '@mui/material/ListItemText'
import { alpha, useTheme } from '@mui/material/styles'
import { stream } from '../services/stream'
import { useThemeMode } from '../ThemeModeProvider'
import { LANGUAGES } from '../i18n'
import { FlagByCC } from '../utils/flags'
import CookieBanner from './CookieBanner'
import ErrorBoundary from './ErrorBoundary'
import Seo from './Seo'
import SpotlightSearch from './SpotlightSearch'
import { buildIssueUrl } from '../utils/issueUrl'

import HomeIcon from '@mui/icons-material/Home'
import DashboardIcon from '@mui/icons-material/Dashboard'
import MapIcon from '@mui/icons-material/Map'
import RadarIcon from '@mui/icons-material/Radar'
import RouterIcon from '@mui/icons-material/Router'
import ForumIcon from '@mui/icons-material/Forum'
import WifiIcon from '@mui/icons-material/Wifi'
import BarChartIcon from '@mui/icons-material/BarChart'
import CodeIcon from '@mui/icons-material/Code'
import LightModeIcon from '@mui/icons-material/LightMode'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import PaletteIcon from '@mui/icons-material/Palette'
import Popover from '@mui/material/Popover'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { ACCENTS } from '../theme'
import TranslateIcon from '@mui/icons-material/Translate'
import CheckIcon from '@mui/icons-material/Check'
import MoreHorizIcon from '@mui/icons-material/MoreHoriz'
import SearchIcon from '@mui/icons-material/Search'
import ListItemIcon from '@mui/material/ListItemIcon'

const NAV = [
  { to: '/',          key: 'home',      Icon: HomeIcon,      exact: true },
  { to: '/packets',   key: 'packets',   Icon: DashboardIcon, exact: false },
  { to: '/map',       key: 'map',       Icon: MapIcon,       exact: false },
  { to: '/live',      key: 'live',      Icon: RadarIcon,     exact: false },
  { to: '/nodes',     key: 'nodes',     Icon: RouterIcon,    exact: false },
  { to: '/channels',  key: 'channels',  Icon: ForumIcon,     exact: false },
  { to: '/observers', key: 'observers', Icon: WifiIcon,      exact: false },
  { to: '/analytics', key: 'analytics', Icon: BarChartIcon,  exact: false },
  { to: '/decode',    key: 'decoder',   Icon: CodeIcon,      exact: false },
] as const

export default function Layout() {
  const theme = useTheme()
  const md3   = theme.palette.md3
  const loc   = useLocation()
  const { t, i18n } = useTranslation()
  const { mode, setMode, accent, setAccent } = useThemeMode()

  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected')
  const [langAnchor, setLangAnchor] = useState<null | HTMLElement>(null)
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null)
  const [themeAnchor, setThemeAnchor] = useState<null | HTMLElement>(null)

  const PRIMARY_NAV = NAV.slice(0, 4)
  const MORE_NAV    = NAV.slice(4)

  useEffect(() => {
    stream.connect()
    setWsStatus(stream.status)
    return stream.onStatus(setWsStatus)
  }, [])

  const statusColor =
    wsStatus === 'connected'  ? '#4caf50' :
    wsStatus === 'connecting' ? '#4caf5088' :
                                 md3.error
  const wsStatusText =
    wsStatus === 'connected'  ? t('common.live') :
    wsStatus === 'connecting' ? t('common.connecting') :
                                t('common.off')
  const wsStatusLabel = `WebSocket: ${wsStatusText}`

  const currentLang = LANGUAGES.find(l => i18n.language?.startsWith(l.code)) ?? LANGUAGES[0]!

  const isActive = (to: string, exact: boolean) =>
    exact ? loc.pathname === to : (loc.pathname === to || loc.pathname.startsWith(to + '/'))
  const openSpotlight = () => window.dispatchEvent(new Event('litescope:open-spotlight'))

  const settingsCluster = (
    <>
      {/* Language switcher */}
      <Tooltip title={t('settings.language')} placement="right">
        <IconButton onClick={e => setLangAnchor(e.currentTarget)}
          sx={{ color: md3.onSurfaceVariant, '&:hover': { background: alpha(md3.onSurface, 0.08) } }}>
          <TranslateIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={langAnchor} open={Boolean(langAnchor)} onClose={() => setLangAnchor(null)}
        anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
        transformOrigin={{ vertical: 'center', horizontal: 'left' }}>
        {LANGUAGES.map(lang => (
          <MenuItem key={lang.code} selected={lang.code === currentLang.code}
            onClick={() => { i18n.changeLanguage(lang.code); setLangAnchor(null) }}
            sx={{ gap: 1, minWidth: 160 }}>
            <FlagByCC cc={lang.cc} size={16} />
            <ListItemText primary={lang.label} />
            {lang.code === currentLang.code && <CheckIcon sx={{ fontSize: 16, color: md3.primary }} />}
          </MenuItem>
        ))}
      </Menu>

      {/* Theme picker */}
      <Tooltip title={t('settings.theme')} placement="right">
        <IconButton onClick={e => setThemeAnchor(e.currentTarget)}
          sx={{ color: md3.onSurfaceVariant, '&:hover': { background: alpha(md3.onSurface, 0.08) } }}>
          <PaletteIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Popover anchorEl={themeAnchor} open={Boolean(themeAnchor)} onClose={() => setThemeAnchor(null)}
        anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
        transformOrigin={{ vertical: 'center', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 1.5, borderRadius: 1.5, minWidth: 220 } } }}>
        {/* Mode toggle */}
        <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontWeight: 600, display: 'block', mb: 0.75 }}>
          {t('settings.mode')}
        </Typography>
        <ToggleButtonGroup
          value={mode}
          exclusive
          fullWidth
          size="small"
          onChange={(_, v) => { if (v) setMode(v) }}
          sx={{ mb: 1.5 }}>
          <ToggleButton value="light">
            <LightModeIcon sx={{ fontSize: 18, mr: 0.75 }} />
            {t('settings.lightMode')}
          </ToggleButton>
          <ToggleButton value="dark">
            <DarkModeIcon sx={{ fontSize: 18, mr: 0.75 }} />
            {t('settings.darkMode')}
          </ToggleButton>
        </ToggleButtonGroup>

        {/* Accent swatches */}
        <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontWeight: 600, display: 'block', mb: 0.75 }}>
          {t('settings.accentColor')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {ACCENTS.map(a => {
            const selected = a.key === accent
            return (
              <Tooltip key={a.key} title={a.label}>
                <Box
                  onClick={() => setAccent(a.key)}
                  sx={{
                    width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
                    background: a.swatch,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `2px solid ${selected ? md3.onSurface : 'transparent'}`,
                    boxShadow: selected ? `0 0 0 2px ${md3.surfaceContainerHigh}` : 'none',
                    transition: 'transform 0.15s, border-color 0.15s',
                    '&:hover': { transform: 'scale(1.1)' },
                  }}>
                  {selected && <CheckIcon sx={{ fontSize: 16, color: '#fff' }} />}
                </Box>
              </Tooltip>
            )
          })}
        </Box>
      </Popover>
    </>
  )

  return (
    <>
    <Seo />
    <Box sx={{ display: 'flex', height: '100dvh', background: md3.background }}>

      {/* ── Navigation Rail — desktop only (md+) ── */}
      <Box component="nav" sx={{
        display: { xs: 'none', md: 'flex' },
        width: 80, flexShrink: 0,
        flexDirection: 'column', alignItems: 'center',
        background: md3.surfaceContainerLow,
        borderRight: `1px solid ${md3.outlineVariant}`,
        pt: 1.5, pb: 1.5, gap: 0.75,
      }}>
        <Box component="img" src="/icon.svg" alt="liteScope"
          sx={{ width: 36, height: 36, mb: 1.5, borderRadius: '10px', boxShadow: `0 2px 8px ${alpha(md3.primary, 0.4)}` }} />

        <Tooltip title={`${t('common.search')} (Ctrl+K)`} placement="right">
          <IconButton aria-label={t('common.search')} onClick={openSpotlight}
            sx={{ color: md3.onSurfaceVariant, mb: 0.75, '&:hover': { background: alpha(md3.onSurface, 0.08) } }}>
            <SearchIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>

        {NAV.map(({ to, key, Icon, exact }) => {
          const active = isActive(to, exact)
          return (
            <Box key={to} component={NavLink} to={to} sx={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
              textDecoration: 'none', width: '100%', py: 0.5,
              color: active ? md3.primary : md3.onSurfaceVariant,
              '&:hover .nav-pill': { background: active ? md3.secondaryContainer : alpha(md3.onSurface, 0.08) },
            }}>
              <Box className="nav-pill" sx={{
                width: 56, height: 32, borderRadius: 50,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: active ? md3.secondaryContainer : 'transparent',
                transition: 'background 0.2s cubic-bezier(0.2, 0, 0, 1)',
              }}>
                <Icon sx={{ fontSize: 20, color: active ? md3.onSecondaryContainer : md3.onSurfaceVariant, transition: 'color 0.2s' }} />
              </Box>
              <Typography sx={{
                fontSize: 11, fontWeight: active ? 700 : 500, letterSpacing: '0.3px', lineHeight: 1,
                color: active ? md3.primary : md3.onSurfaceVariant, transition: 'color 0.2s, font-weight 0.2s',
              }}>
                {t(`nav.${key}`)}
              </Typography>
            </Box>
          )
        })}

        <Box sx={{ flex: 1 }} />

        {settingsCluster}

        {/* WebSocket status */}
        <Tooltip title={wsStatusLabel} placement="right" describeChild>
          <Box component="span" role="status" aria-live="polite" aria-label={wsStatusLabel}
            sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.3, mt: 0.5 }}>
            <Box sx={{
              width: 8, height: 8, borderRadius: '50%', background: statusColor,
              boxShadow: wsStatus === 'connected' ? `0 0 6px ${statusColor}` : 'none', transition: 'all 0.5s',
            }} />
            <Typography sx={{ fontSize: 9, color: md3.onSurfaceVariant, letterSpacing: '0.2px' }}>
              {wsStatusText}
            </Typography>
          </Box>
        </Tooltip>
      </Box>

      {/* ── Main column ── */}
      <Box component="main" sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

        {/* ── Top app bar — mobile only (< md) ── */}
        <Box sx={{
          display: { xs: 'flex', md: 'none' },
          alignItems: 'center', gap: 1,
          px: 1.5, height: 52, flexShrink: 0,
          background: md3.surfaceContainerLow,
          borderBottom: `1px solid ${md3.outlineVariant}`,
        }}>
          <Box component="img" src="/icon.svg" alt="liteScope"
            sx={{ width: 28, height: 28, borderRadius: '8px', boxShadow: `0 1px 4px ${alpha(md3.primary, 0.4)}` }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 700, color: md3.onSurface, letterSpacing: '-0.2px' }}>
            liteScope
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={`${t('common.search')} (Ctrl+K)`}>
            <IconButton aria-label={t('common.search')} onClick={openSpotlight}
              sx={{ color: md3.onSurfaceVariant, '&:hover': { background: alpha(md3.onSurface, 0.08) } }}>
              <SearchIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
          {/* WS dot */}
          <Tooltip title={wsStatusLabel} describeChild>
            <Box component="span" role="status" aria-live="polite" aria-label={wsStatusLabel}
              sx={{
              width: 8, height: 8, borderRadius: '50%', background: statusColor,
              boxShadow: wsStatus === 'connected' ? `0 0 6px ${statusColor}` : 'none', transition: 'all 0.5s',
            }} />
          </Tooltip>
          {settingsCluster}
        </Box>

        {/* ── Page content ── */}
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ErrorBoundary level="page">
            <Suspense fallback={
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <CircularProgress size={28} />
              </Box>
            }>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </Box>

        {/* ── Footer — desktop only ── */}
        <Box component="footer" sx={{
          display: 'flex',
          flexShrink: 0, alignItems: 'center', gap: { xs: 0.75, md: 1 },
          px: { xs: 1.25, md: 2 }, py: { xs: 0.6, md: 0.75 },
          borderTop: `1px solid ${md3.outlineVariant}`,
          background: md3.surfaceContainerLow,
          minWidth: 0,
        }}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, fontSize: { xs: 10, md: 12 }, whiteSpace: 'nowrap' }}>
            © {new Date().getFullYear()} liteScope by{' '}
            <Typography component="a" href="https://riko.dev" target="_blank" rel="noopener noreferrer" variant="caption"
              sx={{ color: md3.primary, textDecoration: 'none', fontSize: 'inherit', '&:hover': { textDecoration: 'underline' } }}>
              riko.dev
            </Typography>
          </Typography>
          <Box sx={{ width: 3, height: 3, borderRadius: '50%', background: md3.outline }} />
          <Typography variant="caption" sx={{
            display: { xs: 'none', sm: 'block' },
            color: md3.outline,
            fontSize: { sm: 10, md: 12 },
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{t('footer.tagline')}</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography component="a" href={buildIssueUrl()} target="_blank" rel="noopener noreferrer" variant="caption"
            sx={{ display: { xs: 'none', sm: 'inline' }, color: md3.onSurfaceVariant, textDecoration: 'none', fontSize: { sm: 10, md: 12 }, whiteSpace: 'nowrap', '&:hover': { color: md3.error, textDecoration: 'underline' } }}>
            {t('error.reportIssue')}
          </Typography>
          <Box sx={{ display: { xs: 'none', sm: 'block' }, width: 3, height: 3, borderRadius: '50%', background: md3.outline }} />
          <Tooltip title="GitHub">
            <Typography component="a" href="https://github.com/RikoDEV/litescope" target="_blank" rel="noopener noreferrer" variant="caption"
              sx={{ color: md3.primary, textDecoration: 'none', fontSize: { xs: 10, md: 12 }, whiteSpace: 'nowrap', '&:hover': { textDecoration: 'underline' } }}>
              {__APP_VERSION__}
            </Typography>
          </Tooltip>
        </Box>

        {/* ── Bottom navigation — mobile only ── */}
        <Box sx={{
          display: { xs: 'flex', md: 'none' },
          flexShrink: 0,
          borderTop: `1px solid ${md3.outlineVariant}`,
          background: md3.surfaceContainerLow,
        }}>
          {/* 4 primary items */}
          {PRIMARY_NAV.map(({ to, key, Icon, exact }) => {
            const active = isActive(to, exact)
            return (
              <Box key={to} component={NavLink} to={to} sx={{
                flex: 1,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: '2px', py: 0.75, textDecoration: 'none',
                color: active ? md3.primary : md3.onSurfaceVariant,
                transition: 'color 0.2s',
              }}>
                <Box sx={{
                  width: 48, height: 28, borderRadius: '14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: active ? alpha(md3.primary, 0.15) : 'transparent',
                  transition: 'background 0.2s',
                }}>
                  <Icon sx={{ fontSize: 20 }} />
                </Box>
                <Typography sx={{ fontSize: 10, fontWeight: active ? 700 : 400, lineHeight: 1, letterSpacing: '0.2px' }}>
                  {t(`nav.${key}`)}
                </Typography>
              </Box>
            )
          })}

          {/* More button */}
          {(() => {
            const moreActive = MORE_NAV.some(({ to, exact }) => isActive(to, exact))
            return (
              <Box
                onClick={e => setMoreAnchor(e.currentTarget)}
                sx={{
                  flex: 1,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: '2px', py: 0.75, cursor: 'pointer',
                  color: moreActive ? md3.primary : md3.onSurfaceVariant,
                  transition: 'color 0.2s',
                }}
              >
                <Box sx={{
                  width: 48, height: 28, borderRadius: '14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: moreActive ? alpha(md3.primary, 0.15) : 'transparent',
                  transition: 'background 0.2s',
                }}>
                  <MoreHorizIcon sx={{ fontSize: 20 }} />
                </Box>
                <Typography sx={{ fontSize: 10, fontWeight: moreActive ? 700 : 400, lineHeight: 1, letterSpacing: '0.2px' }}>
                  {t('nav.more')}
                </Typography>
              </Box>
            )
          })()}
        </Box>

        {/* More menu */}
        <Menu
          anchorEl={moreAnchor}
          open={Boolean(moreAnchor)}
          onClose={() => setMoreAnchor(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          slotProps={{ paper: { sx: { minWidth: 200, borderRadius: 3, background: md3.surfaceContainerHigh } } }}
        >
          {MORE_NAV.map(({ to, key, Icon, exact }) => {
            const active = isActive(to, exact)
            return (
              <MenuItem
                key={to}
                component={NavLink}
                to={to}
                selected={active}
                onClick={() => setMoreAnchor(null)}
                sx={{
                  gap: 1.5, borderRadius: 2, mx: 0.5, mb: 0.25,
                  color: active ? md3.primary : md3.onSurface,
                  '&.Mui-selected': { background: alpha(md3.primary, 0.12) },
                  '&.Mui-selected:hover': { background: alpha(md3.primary, 0.18) },
                }}
              >
                <ListItemIcon sx={{ minWidth: 0, color: 'inherit' }}>
                  <Icon sx={{ fontSize: 20 }} />
                </ListItemIcon>
                <ListItemText primary={t(`nav.${key}`)} slotProps={{ primary: { sx: { fontSize: 14, fontWeight: active ? 700 : 400 } } }} />
              </MenuItem>
            )
          })}
        </Menu>

      </Box>
      </Box>
      <CookieBanner />
      <SpotlightSearch />
    </>
  )
}
