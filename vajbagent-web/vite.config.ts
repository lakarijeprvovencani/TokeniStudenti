import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    crossOriginIsolationPlugin(),
  ],
  build: {
    // Emit bundled JS/CSS under /spa-assets/ instead of the default /assets/
    // so the URLs are in a brand-new namespace that no upstream cache
    // (Render edge, Cloudflare, ISP proxies) has ever seen before.
    // This lets us side-step stranded cached 500 responses without
    // needing dashboard access to any cache.
    assetsDir: 'spa-assets',
  },
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
