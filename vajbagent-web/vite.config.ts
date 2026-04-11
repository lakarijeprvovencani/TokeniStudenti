import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    crossOriginIsolationPlugin(),
  ],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
})

function crossOriginIsolationPlugin() {
  return {
    name: 'cross-origin-isolation',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
        next()
      })
    },
  }
}
