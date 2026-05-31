import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeModeProvider } from './ThemeModeProvider'
import './i18n'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeModeProvider>
      <App />
    </ThemeModeProvider>
  </StrictMode>,
)
