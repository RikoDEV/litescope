import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import GlobalStyles from '@mui/material/GlobalStyles'
import { makeTheme, ACCENTS, DEFAULT_ACCENT, type ThemeMode, type AccentKey } from './theme'

interface ThemeModeCtx {
  mode: ThemeMode
  toggleMode: () => void
  setMode: (m: ThemeMode) => void
  accent: AccentKey
  setAccent: (a: AccentKey) => void
}

const Ctx = createContext<ThemeModeCtx>({
  mode: 'dark', toggleMode: () => {}, setMode: () => {},
  accent: DEFAULT_ACCENT, setAccent: () => {},
})

export const useThemeMode = () => useContext(Ctx)

const LS_KEY = 'litescope-theme-mode'
const LS_ACCENT_KEY = 'litescope-theme-accent'

function initialMode(): ThemeMode {
  const stored = localStorage.getItem(LS_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function initialAccent(): AccentKey {
  const stored = localStorage.getItem(LS_ACCENT_KEY)
  return ACCENTS.some(a => a.key === stored) ? (stored as AccentKey) : DEFAULT_ACCENT
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode)
  const [accent, setAccentState] = useState<AccentKey>(initialAccent)

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    localStorage.setItem(LS_KEY, m)
  }, [])

  const toggleMode = useCallback(() => {
    setModeState(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem(LS_KEY, next)
      return next
    })
  }, [])

  const setAccent = useCallback((a: AccentKey) => {
    setAccentState(a)
    localStorage.setItem(LS_ACCENT_KEY, a)
  }, [])

  const theme = useMemo(() => makeTheme(mode, accent), [mode, accent])
  const ctx   = useMemo(() => ({ mode, toggleMode, setMode, accent, setAccent }), [mode, toggleMode, setMode, accent, setAccent])

  return (
    <Ctx.Provider value={ctx}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <GlobalStyles
          styles={{
            '.leaflet-container .leaflet-control-attribution': {
              fontSize: '9px',
              lineHeight: 1.4,
              padding: '0 4px',
              ...(mode === 'dark'
                ? {
                    background: 'rgba(15, 23, 42, 0.6)',
                    color: 'rgba(255, 255, 255, 0.45)',
                    backdropFilter: 'blur(2px)',
                  }
                : {
                    background: 'rgba(255, 255, 255, 0.7)',
                    color: 'rgba(0, 0, 0, 0.55)',
                  }),
            },
            '.leaflet-container .leaflet-control-attribution a': {
              color: mode === 'dark' ? 'rgba(255, 255, 255, 0.65)' : 'rgba(0, 0, 0, 0.7)',
            },
          }}
        />
        {children}
      </ThemeProvider>
    </Ctx.Provider>
  )
}
