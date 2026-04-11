import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Eye, RefreshCw, ExternalLink, Server, Globe, Package } from 'lucide-react'
import { getServerUrl, onServerReady } from '../services/webcontainer'
import './PreviewPanel.css'

interface PreviewPanelProps {
  files: Record<string, string>
}

export default function PreviewPanel({ files }: PreviewPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [devServerUrl, setDevServerUrl] = useState<string | null>(getServerUrl())
  const [devServerFailed, setDevServerFailed] = useState(false)

  // Listen for dev server ready
  useEffect(() => {
    const existing = getServerUrl()
    if (existing) {
      setDevServerUrl(existing)
      return
    }
    const unsub = onServerReady((url) => {
      setDevServerUrl(url)
    })
    return unsub
  }, [])

  // Detect dev server iframe failure — if iframe loads but stays blank for 6s, fall back to build
  useEffect(() => {
    if (!devServerUrl || devServerFailed) return
    const timer = setTimeout(() => {
      // Check if iframe has content by trying to access it
      // If cross-origin, we can't check — assume failed if we got here
      setDevServerFailed(true)
      console.log('[Preview] Dev server iframe timeout — falling back to build preview')
    }, 8000)
    return () => clearTimeout(timer)
  }, [devServerUrl, refreshKey, devServerFailed])

  const htmlFile = files['index.html'] || files['index.htm'] || null

  // Detect build output (dist/index.html from npm run build)
  const distIndexHtml = files['dist/index.html'] || null
  const hasBuildOutput = !!distIndexHtml
  const hasDevServer = !!devServerUrl && !devServerFailed

  // Determine preview mode
  // Priority: dev server > build output > static HTML
  const previewMode: 'dev-server' | 'build' | 'static' | 'none' =
    hasDevServer ? 'dev-server' :
    hasBuildOutput ? 'build' :
    htmlFile ? 'static' :
    'none'

  // Build inlined HTML from static files (existing logic)
  const buildFullHtml = useCallback((raw: string): string => {
    let html = raw
    html = html.replace(/<link\s+[^>]*href=["'][^"']*\.css["'][^>]*\/?>/gi, '')
    html = html.replace(/<script\s+[^>]*src=["'][^"']*\.js["'][^>]*><\/script>/gi, '')

    const cssBlocks = Object.entries(files)
      .filter(([p]) => p.endsWith('.css') && !p.startsWith('dist/') && !p.includes('node_modules'))
      .map(([p, c]) => `<style>/* ${p} */\n${c}\n</style>`)
      .join('\n')

    const jsBlocks = Object.entries(files)
      .filter(([p]) => p.endsWith('.js') && !p.startsWith('dist/') && !p.includes('node_modules'))
      .map(([p, c]) => `<script>/* ${p} */\n${c}\n</script>`)
      .join('\n')

    if (html.includes('</head>')) {
      html = html.replace('</head>', cssBlocks + '\n</head>')
    } else {
      html = cssBlocks + '\n' + html
    }

    if (html.includes('</body>')) {
      html = html.replace('</body>', jsBlocks + '\n</body>')
    } else {
      html = html + '\n' + jsBlocks
    }

    return html
  }, [files])

  // Build inlined HTML from Vite build output (dist/)
  const buildReactHtml = useCallback((): string | null => {
    if (!distIndexHtml) return null

    let html = distIndexHtml

    // Inline CSS: <link rel="stylesheet" href="/assets/xxx.css"> or "./assets/xxx.css"
    html = html.replace(
      /<link\s+[^>]*href=["'][./]*assets\/([^"']+\.css)["'][^>]*\/?>/gi,
      (_match: string, filename: string) => {
        const key = Object.keys(files).find(k => k.endsWith(`assets/${filename}`))
        if (key && files[key]) return `<style>${files[key]}</style>`
        return ''
      }
    )

    // Inline JS: <script src="/assets/xxx.js"> or "./assets/xxx.js"
    html = html.replace(
      /<script\s+([^>]*)src=["'][./]*assets\/([^"']+\.js)["']([^>]*)><\/script>/gi,
      (_match: string, before: string, filename: string, after: string) => {
        const key = Object.keys(files).find(k => k.endsWith(`assets/${filename}`))
        if (key && files[key]) {
          // Preserve type="module" if present, remove crossorigin
          const attrs = (before + ' ' + after)
            .replace(/crossorigin/gi, '')
            .replace(/src=["'][^"']*["']/gi, '')
            .trim()
          return `<script ${attrs}>${files[key]}</script>`
        }
        return ''
      }
    )

    return html
  }, [files, distIndexHtml])

  // Generate blob URL for static/build preview — debounced
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevBlobUrl = useRef<string | null>(null)

  useEffect(() => {
    if (previewMode === 'dev-server' || previewMode === 'none') return
    if (!iframeRef.current) return

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      if (!iframeRef.current) return
      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current)

      let html: string | null = null
      if (previewMode === 'build') {
        html = buildReactHtml()
      } else if (previewMode === 'static' && htmlFile) {
        html = buildFullHtml(htmlFile)
      }

      if (!html) return

      const blob = new Blob([html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      prevBlobUrl.current = url
      iframeRef.current.src = url
    }, 600)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [htmlFile, distIndexHtml, files, refreshKey, previewMode, buildFullHtml, buildReactHtml])

  if (previewMode === 'none') {
    return (
      <div className="preview-panel">
        <div className="preview-header">
          <Eye size={14} />
          <span>Preview</span>
        </div>
        <div className="preview-empty">
          <motion.div
            className="preview-empty-content"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="preview-empty-icon-wrap">
              <Globe size={28} className="preview-empty-icon" />
              <div className="preview-empty-ring" />
            </div>
            <p>Preview će se pojaviti kada agent kreira index.html ili pokrene dev server</p>
          </motion.div>
        </div>
      </div>
    )
  }

  const urlBarText =
    previewMode === 'dev-server' ? devServerUrl :
    previewMode === 'build' ? 'dist/index.html (build)' :
    'index.html'

  const urlBarIcon =
    previewMode === 'dev-server' ? <Server size={11} className="url-bar-icon server-active" /> :
    previewMode === 'build' ? <Package size={11} className="url-bar-icon build-active" /> :
    <Globe size={11} className="url-bar-icon" />

  return (
    <div className="preview-panel">
      <div className="preview-header">
        <div className="preview-browser-dots">
          <span className="dot dot-red" />
          <span className="dot dot-yellow" />
          <span className="dot dot-green" />
        </div>

        <div className="preview-url-bar">
          {urlBarIcon}
          <span className="url-bar-text">{urlBarText}</span>
        </div>

        <div className="preview-actions">
          {devServerFailed && devServerUrl && (
            <button
              className="preview-action-btn"
              onClick={() => { setDevServerFailed(false); setRefreshKey(k => k + 1) }}
              title="Probaj ponovo dev server"
            >
              <Server size={12} />
            </button>
          )}
          <button
            className="preview-action-btn"
            onClick={() => setRefreshKey(k => k + 1)}
            title="Osveži"
          >
            <RefreshCw size={12} />
          </button>
          <button
            className="preview-action-btn"
            onClick={() => {
              const html = previewMode === 'build' ? buildReactHtml() :
                           previewMode === 'static' && htmlFile ? buildFullHtml(htmlFile) : null
              if (previewMode === 'dev-server' && devServerUrl) {
                window.open(devServerUrl, '_blank')
              } else if (html) {
                const blob = new Blob([html], { type: 'text/html' })
                const url = URL.createObjectURL(blob)
                window.open(url, '_blank')
              }
            }}
            title="Otvori u novom tabu"
          >
            <ExternalLink size={12} />
          </button>
        </div>
      </div>
      <div className="preview-frame-wrap">
        {previewMode === 'dev-server' ? (
          /* Dev server: sandbox + cross-origin-isolated (bolt.diy approach) */
          <iframe
            className="preview-frame"
            src={devServerUrl!}
            title="Preview"
            key={`server-${refreshKey}`}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
            allow="cross-origin-isolated"
          />
        ) : (
          /* Build output or static HTML: sandboxed blob URL */
          <iframe
            ref={iframeRef}
            className="preview-frame"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="Preview"
            key={`blob-${refreshKey}`}
          />
        )}
      </div>
    </div>
  )
}
