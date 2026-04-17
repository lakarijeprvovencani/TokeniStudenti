import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installAuthFetch } from './services/authToken'

// Install the cross-site-cookie fallback BEFORE any module-scope code has a
// chance to start a fetch. Any request to the API host from this point on
// will automatically carry `Authorization: Bearer <key>` when localStorage
// holds one — this is what keeps the app working on Safari/Brave/Firefox-
// strict where third-party cookies for vajbagent.com are blocked.
installAuthFetch()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
