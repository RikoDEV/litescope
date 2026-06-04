import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeModeProvider } from './ThemeModeProvider'
import './i18n'
import i18n from './i18n'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { getEnv } from './env'

// Keep <html lang> in sync with the active i18n language
const syncLang = (lng: string) => { document.documentElement.lang = lng.split('-')[0] }
syncLang(i18n.language)
i18n.on('languageChanged', syncLang)

const umamiUrl = getEnv('VITE_UMAMI_URL')
const umamiId  = getEnv('VITE_UMAMI_WEBSITE_ID')
if (umamiUrl && umamiId) {
  const s = document.createElement('script')
  s.defer = true
  s.src = umamiUrl
  s.dataset.websiteId = umamiId
  document.head.appendChild(s)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary level="app">
      <ThemeModeProvider>
        <App />
      </ThemeModeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
