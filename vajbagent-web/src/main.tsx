import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installAuthFetch } from './services/authToken'
import { ensurePreviewServer } from './services/previewServer'

// Install the cross-site-cookie fallback BEFORE any module-scope code has a
// chance to start a fetch. Any request to the API host from this point on
// will automatically carry `Authorization: Bearer <key>` when localStorage
// holds one — this is what keeps the app working on Safari/Brave/Firefox-
// strict where third-party cookies for vajbagent.com are blocked.
installAuthFetch()

// Kick off preview service worker registration asynchronously. It doesn't
// block first paint and will be ready by the time the user's first
// preview render happens. Failures (SSR, unsupported browser) are safe —
// PreviewPanel falls back to the blob path automatically.
ensurePreviewServer().catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
