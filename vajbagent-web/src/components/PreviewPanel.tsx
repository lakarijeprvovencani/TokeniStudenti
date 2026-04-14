import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Eye, RefreshCw, ExternalLink, Server, Globe, Package } from 'lucide-react'
import { getServerUrl, onServerReady } from '../services/webcontainer'
import './PreviewPanel.css'

interface PreviewPanelProps {
  files: Record<string, string>
}

/** Script injected into blob HTML to intercept ALL link navigation and enable multi-page preview */
const NAV_INTERCEPT_SCRIPT = `
<script>
(function() {
  function handleNav(e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentElement;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    // Let anchors and external links through
    if (href.startsWith('#')) return;
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // Normalize: /about → about, ./about → about, /about/ → about
    var page = href.replace(/^\\.?\\//, '').replace(/\\/$/, '').replace(/\\.html$/, '') || 'index';
    window.parent.postMessage({ type: 'vajb-navigate', page: page }, '*');
    return false;
  }
  document.addEventListener('click', handleNav, true);
  // Block all other navigation attempts
  window.addEventListener('beforeunload', function(e) { e.preventDefault(); });
})();
</script>
`

export default function PreviewPanel({ files }: PreviewPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [devServerUrl, setDevServerUrl] = useState<string | null>(getServerUrl())
  const [devServerFailed, setDevServerFailed] = useState(false)
  const [currentPage, setCurrentPage] = useState('index')

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
      setDevServerFailed(true)
      console.log('[Preview] Dev server iframe timeout — falling back to build preview')
    }, 8000)
    return () => clearTimeout(timer)
  }, [devServerUrl, refreshKey, devServerFailed])

  // Listen for navigation messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'vajb-navigate') {
        const page = e.data.page as string
        console.log('[Preview] Navigate to:', page)
        setCurrentPage(page)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const htmlFile = files['index.html'] || files['index.htm'] || null

  // Detect build output (dist/index.html for Vite, out/index.html for Next.js)
  const distIndexHtml = files['dist/index.html'] || files['out/index.html'] || null
  const hasBuildOutput = !!distIndexHtml
  const hasDevServer = !!devServerUrl && !devServerFailed
  const isNextJsBuild = !!files['out/index.html']

  // Find the build output dir prefix
  const buildDir = files['out/index.html'] ? 'out' : 'dist'

  // Determine preview mode
  const previewMode: 'dev-server' | 'build' | 'static' | 'none' =
    hasDevServer ? 'dev-server' :
    hasBuildOutput ? 'build' :
    htmlFile ? 'static' :
    'none'

  // Find the HTML file for a given page in the build output
  const findPageHtml = useCallback((page: string): string | null => {
    // Try exact match: out/about.html, dist/about.html
    const candidates = [
      `${buildDir}/${page}.html`,
      `${buildDir}/${page}/index.html`,
      `${buildDir}/${page}`,
    ]
    for (const c of candidates) {
      if (files[c]) return files[c]
    }
    return null
  }, [files, buildDir])

  /**
   * Replace <img src="/foo.jpg" /> and url("/foo.jpg") in inline CSS with
   * the actual data URL for the matching file in the React state, so
   * user-uploaded images render inside the blob preview iframe (which
   * lives on a throwaway blob: origin with no filesystem).
   */
  const inlineImageRefs = useCallback((html: string): string => {
    const imageEntries = Object.entries(files).filter(
      ([p, c]) => /\.(jpg|jpeg|png|webp|gif|svg|avif)$/i.test(p) && typeof c === 'string' && c.startsWith('data:')
    )
    if (imageEntries.length === 0) return html

    const findDataUrl = (ref: string): string | null => {
      const cleaned = ref.replace(/^\.?\//, '').replace(/^public\//, '')
      for (const [p, data] of imageEntries) {
        const normalized = p.replace(/^public\//, '')
        if (normalized === cleaned || p === cleaned || p === ref) return data
        if (p.endsWith('/' + cleaned) || normalized.endsWith('/' + cleaned)) return data
      }
      return null
    }

    // <img src="...">, <source srcset="...">, background="..."
    html = html.replace(/(<img\b[^>]*\bsrc=)(["'])([^"']+)(\2)/gi, (match, head, q, src, _q) => {
      const data = findDataUrl(src)
      return data ? `${head}${q}${data}${q}` : match
    })
    html = html.replace(/(<source\b[^>]*\bsrcset=)(["'])([^"']+)(\2)/gi, (match, head, q, src, _q) => {
      const data = findDataUrl(src)
      return data ? `${head}${q}${data}${q}` : match
    })
    // url(...) inside inline <style> and style="..." attributes
    html = html.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, q, src) => {
      if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('#')) return match
      const data = findDataUrl(src)
      return data ? `url(${q}${data}${q})` : match
    })
    return html
  }, [files])

  // Build inlined HTML from static files (existing logic)
  const buildFullHtml = useCallback((raw: string): string => {
    let html = raw
    html = html.replace(/<link\s+[^>]*href=["'][^"']*\.css["'][^>]*\/?>/gi, '')
    html = html.replace(/<script\s+[^>]*src=["'][^"']*\.js["'][^>]*><\/script>/gi, '')

    const cssBlocks = Object.entries(files)
      .filter(([p]) => p.endsWith('.css') && !p.startsWith('dist/') && !p.startsWith('out/') && !p.includes('node_modules'))
      .map(([p, c]) => `<style>/* ${p} */\n${c}\n</style>`)
      .join('\n')

    const jsBlocks = Object.entries(files)
      .filter(([p]) => p.endsWith('.js') && !p.startsWith('dist/') && !p.startsWith('out/') && !p.includes('node_modules'))
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

    return inlineImageRefs(html)
  }, [files, inlineImageRefs])

  // Build inlined HTML from build output for a specific page
  const buildPageHtml = useCallback((pageHtml: string): string => {
    let html = pageHtml

    // Inline ALL CSS <link> tags
    html = html.replace(
      /<link\s+[^>]*href=["']([^"']+\.css)["'][^>]*\/?>/gi,
      (_match: string, href: string) => {
        const cleanHref = href.replace(/^[./]+/, '')
        const key = Object.keys(files).find(k => k.endsWith(cleanHref) || k.includes(cleanHref))
        if (key && files[key]) return `<style>${files[key]}</style>`
        return ''
      }
    )

    if (isNextJsBuild) {
      // Next.js: SSR content is in HTML, remove JS (can't inline chunks)
      html = html.replace(/<script\s+[^>]*src=["'][^"']*["'][^>]*><\/script>/gi, '')
      html = html.replace(/<script\s+id="__NEXT_DATA__"[^>]*>[\s\S]*?<\/script>/gi, '')
    } else {
      // Vite: inline JS
      html = html.replace(
        /<script\s+([^>]*)src=["']([^"']+\.js)["']([^>]*)><\/script>/gi,
        (_match: string, before: string, href: string, after: string) => {
          const cleanHref = href.replace(/^[./]+/, '')
          const key = Object.keys(files).find(k => k.endsWith(cleanHref) || k.includes(cleanHref))
          if (key && files[key]) {
            if (files[key].length > 200000) return ''
            const attrs = (before + ' ' + after)
              .replace(/crossorigin/gi, '')
              .replace(/src=["'][^"']*["']/gi, '')
              .trim()
            return `<script ${attrs}>${files[key]}</script>`
          }
          return ''
        }
      )
    }

    // Inject navigation interceptor before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', NAV_INTERCEPT_SCRIPT + '\n</body>')
    } else {
      html += NAV_INTERCEPT_SCRIPT
    }

    return inlineImageRefs(html)
  }, [files, isNextJsBuild, inlineImageRefs])

  // Generate blob URL for current page — debounced
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
        // Multi-page: find the right page HTML
        let pageHtml: string | null = null
        if (currentPage === 'index') {
          pageHtml = distIndexHtml
        } else {
          pageHtml = findPageHtml(currentPage)
        }
        // Fallback to index if page not found
        if (!pageHtml) pageHtml = distIndexHtml
        if (pageHtml) html = buildPageHtml(pageHtml)
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
  }, [htmlFile, distIndexHtml, files, refreshKey, previewMode, currentPage, buildFullHtml, buildPageHtml, findPageHtml])

  // Build a self-contained multi-page HTML for "open in new tab"
  // All pages are embedded with a hash router (#about, #projects, etc.)
  const buildFullSiteBlob = useCallback((): string | null => {
    if (previewMode === 'static' && htmlFile) {
      return buildFullHtml(htmlFile)
    }
    if (previewMode !== 'build' || !distIndexHtml) return null

    // Collect all HTML pages from build output
    const prefix = buildDir + '/'
    const pages: Record<string, string> = {}
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix) || !path.endsWith('.html')) continue
      // Derive page name: out/about.html → about, out/index.html → index
      let pageName = path.slice(prefix.length).replace(/\.html$/, '').replace(/\/index$/, '')
      if (!pageName) pageName = 'index'
      pages[pageName] = buildPageHtml(content)
    }

    if (Object.keys(pages).length <= 1 && pages['index']) {
      // Single page — just return it
      return pages['index']
    }

    // Multi-page: wrap all pages in a hash-router shell
    // Extract <style> blocks from index page for shared styles
    const indexPage = pages['index'] || ''
    const styleMatches = indexPage.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []
    const sharedStyles = styleMatches.join('\n')

    // Extract body content from each page
    const pageContents: Record<string, string> = {}
    for (const [name, html] of Object.entries(pages)) {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
      pageContents[name] = bodyMatch ? bodyMatch[1] : html
      // Remove injected nav intercept script from body content
      pageContents[name] = pageContents[name].replace(/<script>[\s\S]*?vajb-navigate[\s\S]*?<\/script>/gi, '')
    }

    const pageDataJson = JSON.stringify(pageContents)

    return `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${sharedStyles}
<style>
  .vajb-nav-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #1a1a2e; padding: 8px 16px; display: flex; gap: 8px; z-index: 9999; border-top: 1px solid #333; flex-wrap: wrap; }
  .vajb-nav-bar a { color: #aaa; text-decoration: none; font: 12px/1.4 system-ui; padding: 4px 10px; border-radius: 4px; transition: all 0.2s; }
  .vajb-nav-bar a:hover, .vajb-nav-bar a.active { color: #fff; background: rgba(249,115,22,0.3); }
  body { padding-bottom: 44px !important; }
</style>
</head>
<body>
<div id="vajb-page-root"></div>
<nav class="vajb-nav-bar" id="vajb-nav"></nav>
<script>
(function() {
  var pages = ${pageDataJson};
  var root = document.getElementById('vajb-page-root');
  var nav = document.getElementById('vajb-nav');
  var names = Object.keys(pages);
  // Build nav
  nav.innerHTML = names.map(function(n) {
    return '<a href="#' + n + '">' + (n === 'index' ? 'Početna' : n.charAt(0).toUpperCase() + n.slice(1)) + '</a>';
  }).join('');
  function show() {
    var h = location.hash.replace('#','') || 'index';
    root.innerHTML = pages[h] || pages['index'] || '<p>Stranica nije pronađena</p>';
    var links = nav.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].className = links[i].getAttribute('href') === '#' + h ? 'active' : '';
    }
  }
  window.addEventListener('hashchange', show);
  // Intercept internal links
  document.addEventListener('click', function(e) {
    var a = e.target; while (a && a.tagName !== 'A') a = a.parentElement;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) return;
    e.preventDefault();
    var page = href.replace(/^\\.?\\//, '').replace(/\\/$/, '').replace(/\\.html$/, '') || 'index';
    location.hash = page;
  }, true);
  show();
})();
</script>
</body>
</html>`
  }, [files, buildDir, distIndexHtml, previewMode, htmlFile, buildFullHtml, buildPageHtml])

  // Reset to index when files change significantly (new build)
  const prevDistRef = useRef(distIndexHtml)
  useEffect(() => {
    if (distIndexHtml !== prevDistRef.current) {
      prevDistRef.current = distIndexHtml
      setCurrentPage('index')
    }
  }, [distIndexHtml])

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
    previewMode === 'build' ? `${buildDir}/${currentPage === 'index' ? 'index.html' : currentPage + '.html'} (build)` :
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
          {previewMode === 'build' && currentPage !== 'index' && (
            <button
              className="preview-action-btn"
              onClick={() => setCurrentPage('index')}
              title="Početna"
            >
              <Globe size={12} />
            </button>
          )}
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
              if (previewMode === 'dev-server' && devServerUrl) {
                window.open(devServerUrl, '_blank')
              } else {
                const fullSite = buildFullSiteBlob()
                if (fullSite) {
                  const blob = new Blob([fullSite], { type: 'text/html' })
                  window.open(URL.createObjectURL(blob), '_blank')
                }
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
          <iframe
            className="preview-frame"
            src={devServerUrl!}
            title="Preview"
            key={`server-${refreshKey}`}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
            allow="cross-origin-isolated"
          />
        ) : (
          <iframe
            ref={iframeRef}
            className="preview-frame"
            /*
              SECURITY: no allow-same-origin on the blob path. Blob URLs inherit
              the creator origin, so combining allow-same-origin with allow-scripts
              would let user-generated HTML in the preview read this origin's
              localStorage (API key, Supabase tokens, etc.). With an opaque origin
              the preview still runs scripts but is isolated from the host app.
            */
            sandbox="allow-scripts allow-forms allow-popups"
            title="Preview"
            key={`blob-${refreshKey}`}
          />
        )}
      </div>
    </div>
  )
}
