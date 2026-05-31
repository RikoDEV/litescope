import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
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

// Icons
import HomeIcon from '@mui/icons-material/Home'
import DashboardIcon from '@mui/icons-material/Dashboard'
import MapIcon from '@mui/icons-material/Map'
import RouterIcon from '@mui/icons-material/Router'
import ForumIcon from '@mui/icons-material/Forum'
import WifiIcon from '@mui/icons-material/Wifi'
import BarChartIcon from '@mui/icons-material/BarChart'
import CodeIcon from '@mui/icons-material/Code'
import LightModeIcon from '@mui/icons-material/LightMode'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import TranslateIcon from '@mui/icons-material/Translate'
import CheckIcon from '@mui/icons-material/Check'

const NAV = [
  { to: '/',          key: 'home',      Icon: HomeIcon,      exact: true },
  { to: '/packets',   key: 'packets',   Icon: DashboardIcon, exact: false },
  { to: '/map',       key: 'map',       Icon: MapIcon,       exact: false },
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
  const { mode, toggleMode } = useThemeMode()

  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected')
  const [langAnchor, setLangAnchor] = useState<null | HTMLElement>(null)

  useEffect(() => {
    stream.connect()
    const id = setInterval(() => setWsStatus(stream.status), 1500)
    return () => clearInterval(id)
  }, [])

  const statusColor =
    wsStatus === 'connected'   ? md3.tertiary :
    wsStatus === 'connecting'  ? md3.tertiary + '88' :
                                  md3.error

  const currentLang = LANGUAGES.find(l => i18n.language?.startsWith(l.code)) ?? LANGUAGES[0]

  return (
    <Box sx={{ display: 'flex', height: '100vh', background: md3.background }}>

      {/* ── Navigation Rail (MD3) ── */}
      <Box
        component="nav"
        sx={{
          width: 80, flexShrink: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: md3.surfaceContainerLow,
          borderRight: `1px solid ${md3.outlineVariant}`,
          pt: 1.5, pb: 1.5, gap: 0.75,
        }}
      >
        {/* Brand icon */}
        <Box component="img" src="/icon.svg" alt="liteScope"
          sx={{ width: 36, height: 36, mb: 1.5, borderRadius: '10px', boxShadow: `0 2px 8px ${alpha(md3.primary, 0.4)}` }} />

        {/* Nav items */}
        {NAV.map(({ to, key, Icon, exact }) => {
          const isActive = exact ? loc.pathname === to : (loc.pathname === to || loc.pathname.startsWith(to + '/'))
          return (
            <Box key={to} component={NavLink} to={to}
              sx={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                textDecoration: 'none', width: '100%', py: 0.5,
                '&:hover .nav-pill': { background: isActive ? md3.secondaryContainer : alpha(md3.onSurface, 0.08) },
              }}
            >
              <Box className="nav-pill"
                sx={{
                  width: 56, height: 32, borderRadius: 50,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isActive ? md3.secondaryContainer : 'transparent',
                  transition: 'background 0.2s cubic-bezier(0.2, 0, 0, 1)',
                }}
              >
                <Icon sx={{ fontSize: 20, color: isActive ? md3.onSecondaryContainer : md3.onSurfaceVariant, transition: 'color 0.2s' }} />
              </Box>
              <Typography sx={{
                fontSize: 11, fontWeight: isActive ? 700 : 500, letterSpacing: '0.3px', lineHeight: 1,
                color: isActive ? md3.primary : md3.onSurfaceVariant, transition: 'color 0.2s, font-weight 0.2s',
              }}>
                {t(`nav.${key}`)}
              </Typography>
            </Box>
          )
        })}

        <Box sx={{ flex: 1 }} />

        {/* ── Settings cluster ── */}
        {/* Language switcher */}
        <Tooltip title={t('settings.language')} placement="right">
          <IconButton
            onClick={e => setLangAnchor(e.currentTarget)}
            sx={{ color: md3.onSurfaceVariant, '&:hover': { background: alpha(md3.onSurface, 0.08) } }}
          >
            <TranslateIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={langAnchor}
          open={Boolean(langAnchor)}
          onClose={() => setLangAnchor(null)}
          anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
          transformOrigin={{ vertical: 'center', horizontal: 'left' }}
        >
          {LANGUAGES.map(lang => (
            <MenuItem
              key={lang.code}
              selected={lang.code === currentLang.code}
              onClick={() => { i18n.changeLanguage(lang.code); setLangAnchor(null) }}
              sx={{ gap: 1, minWidth: 160 }}
            >
              <Box component="span" sx={{ fontSize: 16 }}>{lang.flag}</Box>
              <ListItemText primary={lang.label} />
              {lang.code === currentLang.code && <CheckIcon sx={{ fontSize: 16, color: md3.primary }} />}
            </MenuItem>
          ))}
        </Menu>

        {/* Theme toggle */}
        <Tooltip title={mode === 'dark' ? t('settings.lightMode') : t('settings.darkMode')} placement="right">
          <IconButton
            onClick={toggleMode}
            sx={{ color: md3.onSurfaceVariant, '&:hover': { background: alpha(md3.onSurface, 0.08) } }}
          >
            {mode === 'dark' ? <LightModeIcon sx={{ fontSize: 20 }} /> : <DarkModeIcon sx={{ fontSize: 20 }} />}
          </IconButton>
        </Tooltip>

        {/* WebSocket status */}
        <Tooltip title={`WebSocket: ${wsStatus}`} placement="right">
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.3, mt: 0.5 }}>
            <Box sx={{
              width: 8, height: 8, borderRadius: '50%', background: statusColor,
              boxShadow: wsStatus === 'connected' ? `0 0 6px ${statusColor}` : 'none', transition: 'all 0.5s',
            }} />
            <Typography sx={{ fontSize: 9, color: md3.onSurfaceVariant, letterSpacing: '0.2px' }}>
              {wsStatus === 'connected' ? t('common.live') : wsStatus === 'connecting' ? t('common.connecting') : t('common.off')}
            </Typography>
          </Box>
        </Tooltip>
      </Box>

      {/* ── Page content + footer ── */}
      <Box component="main" sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Outlet />
        </Box>

        {/* ── Footer ── */}
        <Box component="footer" sx={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1,
          px: 2, py: 0.75, borderTop: `1px solid ${md3.outlineVariant}`, background: md3.surfaceContainerLow,
        }}>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>
            © {new Date().getFullYear()} liteScope by{' '}
            <Typography component="a" href="https://riko.dev" target="_blank" rel="noopener noreferrer" variant="caption"
              sx={{ color: md3.primary, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
              riko.dev
            </Typography>
          </Typography>
          <Box sx={{ width: 3, height: 3, borderRadius: '50%', background: md3.outline }} />
          <Typography variant="caption" sx={{ color: md3.outline }}>{t('footer.tagline')}</Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="GitHub">
            <Typography component="a" href="https://github.com/RikoDEV/litescope" target="_blank" rel="noopener noreferrer" variant="caption"
              sx={{ color: md3.primary, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
              v0.1.0
            </Typography>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  )
}
