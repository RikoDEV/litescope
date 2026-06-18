import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeModeProvider } from './ThemeModeProvider'
import './i18n'
import i18n from './i18n'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { getEnv, waitForEnv } from './env'

// Keep <html lang> in sync with the active i18n language
const syncLang = (lng: string) => { document.documentElement.lang = lng.split('-')[0] ?? 'en' }
syncLang(i18n.language)
i18n.on('languageChanged', syncLang)

const loadUmami = () => {
  const umamiUrl = getEnv('VITE_UMAMI_URL')
  const umamiId  = getEnv('VITE_UMAMI_WEBSITE_ID')
  if (!umamiUrl || !umamiId || document.querySelector('script[data-umami-loader="true"]')) return

  const s = document.createElement('script')
  s.defer = true
  s.src = umamiUrl
  s.dataset.websiteId = umamiId
  s.dataset.umamiLoader = 'true'
  document.head.appendChild(s)
}

void waitForEnv(() => Boolean(getEnv('VITE_UMAMI_URL') && getEnv('VITE_UMAMI_WEBSITE_ID'))).then(loadUmami)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary level="app">
      <ThemeModeProvider>
        <App />
      </ThemeModeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
