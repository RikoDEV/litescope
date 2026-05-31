import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { makeTheme, type ThemeMode } from './theme'

interface ThemeModeCtx {
  mode: ThemeMode
  toggleMode: () => void
  setMode: (m: ThemeMode) => void
}

const Ctx = createContext<ThemeModeCtx>({ mode: 'dark', toggleMode: () => {}, setMode: () => {} })

export const useThemeMode = () => useContext(Ctx)

const LS_KEY = 'litescope-theme-mode'

function initialMode(): ThemeMode {
  const stored = localStorage.getItem(LS_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode)

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

  const theme = useMemo(() => makeTheme(mode), [mode])
  const ctx   = useMemo(() => ({ mode, toggleMode, setMode }), [mode, toggleMode, setMode])

  return (
    <Ctx.Provider value={ctx}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </Ctx.Provider>
  )
}
