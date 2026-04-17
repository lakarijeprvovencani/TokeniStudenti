import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Eye, RefreshCw, ExternalLink, Server, Globe, Package } from 'lucide-react'
import { getServerUrl, onServerReady } from '../services/webcontainer'
import { ensurePreviewServer, publishPreview, previewUrl, previewSessionId } from '../services/previewServer'
import './PreviewPanel.css'

interface PreviewPanelProps {
  files: Record<string, string>
}

/**
 * Scroll-reveal JS shield injected into blob preview HTML.
 *
 * Problem: models love scroll-triggered reveal animations (opacity:0 +
 * IntersectionObserver adds a ".visible" class). In a blob iframe with
 * no real scroll container, the observer often never fires and whole
 * sections stay invisible.
 *
 * Solution (JS only, no !important CSS):
 *   Walk the DOM after load and add every common "already revealed"
 *   marker class (visible, in-view, aos-animate, animated, revealed…)
 *   to any element that looks like a scroll reveal target. The user's
 *   own CSS then handles the transition to the visible state normally.
 *
 * Why no !important CSS anymore: an earlier version forced
 * opacity:1!important / transform:none!important / visibility:visible
 * on substring selectors like [class*="fade-"] and broke legitimate
 * layouts (mobile menu toggles, .header-slide, .scroll-container, etc.).
 * Pure JS class-addition is surgical — it only affects elements that
 * were ACTUALLY hidden waiting for a scroll trigger, never touches
 * display:none / visibility:hidden used for responsive design.
 */
const PREVIEW_REVEAL_SHIELD = `
<script data-vajb-shield>
(function(){
  var TARGET_SELECTORS = [
    '.fade-in','.fade-up','.fade-down','.fade-left','.fade-right',
    '.slide-in','.slide-up','.slide-down','.slide-left','.slide-right',
    '.reveal','.reveal-up','.reveal-down',
    '.animate-on-scroll','.scroll-reveal','.scroll-fade',
    '[data-aos]','[data-animate]','[data-reveal]','[data-scroll-reveal]'
  ].join(',');
  var MARKER_CLASSES = ['visible','in-view','is-visible','aos-animate','animated','active','show','shown','revealed'];
  function reveal(){
    try {
      var nodes = document.querySelectorAll(TARGET_SELECTORS);
      for (var i = 0; i < nodes.length; i++) {
        for (var j = 0; j < MARKER_CLASSES.length; j++) {
          nodes[i].classList.add(MARKER_CLASSES[j]);
        }
      }
    } catch(e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal);
  } else {
    reveal();
  }
  setTimeout(reveal, 50);
  setTimeout(reveal, 300);
  setTimeout(reveal, 1000);
})();
</script>
`

/**
 * Tiny reporter injected into SW-served HTML so the parent panel's URL
 * bar + back-to-home logic stays in sync when the iframe navigates
 * natively (e.g. user clicks <a href="about.html"> inside the preview).
 * No navigation interception — native clicks just work under SW mode.
 */
const SW_PAGE_REPORTER = `
<script data-vajb-reporter>
(function() {
  function report() {
    try {
      var p = location.pathname || '';
      var m = p.match(/__vajb_preview\\/[^/]+\\/(.*)$/);
      var page = m ? m[1].replace(/\\.html?$/,'') || 'index' : '';
      window.parent.postMessage({ type: 'vajb-page-loaded', page: page }, '*');
    } catch(e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report);
  } else {
    report();
  }
})();
</script>
`

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

  // Service-worker-backed preview state. Once the worker is active we switch
  // the iframe from blob: URLs to same-origin /__vajb_preview/<sid>/... URLs
  // so native navigation, fetch(), <link href>, etc. all resolve cleanly.
  // swReady flips once per mount; before that we silently use the blob path.
  const [swReady, setSwReady] = useState(false)
  const sessionIdRef = useRef<string>(previewSessionId())

  useEffect(() => {
    let cancelled = false
    ensurePreviewServer().then(reg => {
      if (!cancelled && reg) setSwReady(true)
    })
    return () => { cancelled = true }
  }, [])

  // Iframe reports the page it just loaded (see SW_PAGE_REPORTER). We mirror
  // it into currentPage so the URL bar + back-to-home button stay accurate
  // when the user navigates natively inside the preview.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'vajb-page-loaded' && typeof e.data.page === 'string') {
        setCurrentPage(e.data.page || 'index')
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

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
      ([p, c]) => /\.(jpg|jpeg|png|webp|gif|svg|avif|mp4|webm)$/i.test(p) && typeof c === 'string' &&
        (c.startsWith('data:') || c.startsWith('https://'))
    )
    if (imageEntries.length === 0) return html

    const findImageUrl = (ref: string): string | null => {
      const cleaned = ref.replace(/^\.?\//, '').replace(/^public\//, '')
      for (const [p, data] of imageEntries) {
        const normalized = p.replace(/^public\//, '')
        if (normalized === cleaned || p === cleaned || p === ref) return data
        if (p.endsWith('/' + cleaned) || normalized.endsWith('/' + cleaned)) return data
      }
      return null
    }

    html = html.replace(/(<(?:img|video)\b[^>]*\bsrc=)(["'])([^"']+)(\2)/gi, (match, head, q, src, _q) => {
      const url = findImageUrl(src)
      return url ? `${head}${q}${url}${q}` : match
    })
    html = html.replace(/(<source\b[^>]*\b(?:srcset|src)=)(["'])([^"']+)(\2)/gi, (match, head, q, src, _q) => {
      const url = findImageUrl(src)
      return url ? `${head}${q}${url}${q}` : match
    })
    html = html.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, q, src) => {
      if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('#')) return match
      const url = findImageUrl(src)
      return url ? `url(${q}${url}${q})` : match
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
      // Shield goes LAST in <head> so its !important CSS overrides anything
      // the user's stylesheet set earlier in the cascade.
      html = html.replace('</head>', cssBlocks + '\n' + PREVIEW_REVEAL_SHIELD + '\n</head>')
    } else {
      html = cssBlocks + '\n' + PREVIEW_REVEAL_SHIELD + '\n' + html
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

    // Inject reveal shield in <head> and navigation interceptor before </body>
    if (html.includes('</head>')) {
      html = html.replace('</head>', PREVIEW_REVEAL_SHIELD + '\n</head>')
    } else {
      html = PREVIEW_REVEAL_SHIELD + '\n' + html
    }
    if (html.includes('</body>')) {
      html = html.replace('</body>', NAV_INTERCEPT_SCRIPT + '\n</body>')
    } else {
      html += NAV_INTERCEPT_SCRIPT
    }

    return inlineImageRefs(html)
  }, [files, isNextJsBuild, inlineImageRefs])

  /**
   * Inject standard preview boilerplate into an HTML document: UTF-8 meta
   * tag, the scroll-reveal shield, and (in SW mode) the page-load reporter.
   * Shared by both the SW file-map builder and the legacy blob path.
   */
  const decorateHtml = useCallback((raw: string, forSW: boolean): string => {
    let html = raw
    if (!/<meta[^>]+charset/i.test(html)) {
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, '<head$1><meta charset="UTF-8">')
      } else if (/<html[^>]*>/i.test(html)) {
        html = html.replace(/<html([^>]*)>/i, '<html$1><head><meta charset="UTF-8"></head>')
      } else {
        html = '<meta charset="UTF-8">\n' + html
      }
    }
    const headInjection = PREVIEW_REVEAL_SHIELD + (forSW ? SW_PAGE_REPORTER : '')
    if (html.includes('</head>')) html = html.replace('</head>', headInjection + '\n</head>')
    else html = headInjection + '\n' + html
    return html
  }, [])

  /**
   * Build the file map for the SW from the current files object.
   * Returns { map, pageNames, entry } where entry is the initial page to load.
   *
   * In `static` mode we publish source files under their own paths. In
   * `build` mode we strip the dist/|out/ prefix so the iframe can address
   * pages as /about.html instead of /dist/about.html.
   */
  const buildSWFileMap = useCallback((): { map: Record<string, string>; entry: string } | null => {
    const map: Record<string, string> = {}
    const skipPrefix = /^(node_modules|\.git|\.next|\.nuxt|\.cache)\//

    if (previewMode === 'build') {
      const prefix = buildDir + '/'
      for (const [p, c] of Object.entries(files)) {
        if (!p.startsWith(prefix)) continue
        if (skipPrefix.test(p)) continue
        if (typeof c !== 'string') continue
        const stripped = p.slice(prefix.length)
        if (!stripped || stripped.endsWith('/')) continue
        map[stripped] = stripped.endsWith('.html') ? decorateHtml(c, true) : c
      }
      // Also expose uploaded images that live outside dist/ (public/…)
      for (const [p, c] of Object.entries(files)) {
        if (p.startsWith(prefix)) continue
        if (!/\.(jpg|jpeg|png|webp|gif|svg|avif|ico|mp4|webm|mp3|wav|woff2?|ttf|otf)$/i.test(p)) continue
        if (typeof c !== 'string') continue
        if (!(c.startsWith('data:') || c.startsWith('http'))) continue
        const cleaned = p.replace(/^public\//, '')
        if (!map[cleaned]) map[cleaned] = c
      }
      if (!map['index.html']) return null
      return { map, entry: 'index.html' }
    }

    if (previewMode === 'static') {
      for (const [p, c] of Object.entries(files)) {
        if (skipPrefix.test(p)) continue
        if (p.startsWith('dist/') || p.startsWith('out/')) continue
        if (typeof c !== 'string') continue
        if (p.endsWith('/')) continue
        // Hoist public/ to root so <img src="/hero.jpg"> works like it will on Netlify.
        const key = p.replace(/^public\//, '')
        map[key] = /\.html?$/i.test(p) ? decorateHtml(c, true) : c
      }
      if (!map['index.html'] && !map['index.htm']) return null
      return { map, entry: map['index.html'] ? 'index.html' : 'index.htm' }
    }

    return null
  }, [files, previewMode, buildDir, decorateHtml])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevBlobUrl = useRef<string | null>(null)
  const prevHtmlHash = useRef<string | null>(null)
  const prevMapHash = useRef<string | null>(null)
  const iframeInitialized = useRef(false)
  const initialRefreshKeyRef = useRef(0)

  // Reset SW iframe tracking when preview mode flips (static → build, etc.)
  // so we reboot the iframe onto the correct entry page.
  useEffect(() => {
    iframeInitialized.current = false
    prevMapHash.current = null
  }, [previewMode])

  // ─── SW-backed preview (primary path) ───────────────────────────────
  useEffect(() => {
    if (!swReady) return
    if (previewMode === 'dev-server' || previewMode === 'none') return
    if (!iframeRef.current) return

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      if (!iframeRef.current) return
      const built = buildSWFileMap()
      if (!built) return

      // Hash the map so we don't re-publish + reload on no-op file changes
      // (autosave churn, unrelated tool calls, etc.). FNV-1a over the
      // concatenated key+length tuples is plenty discriminating.
      let h = 2166136261
      for (const [k, v] of Object.entries(built.map)) {
        const sig = k + ':' + (typeof v === 'string' ? v.length : 0) + ':' + (typeof v === 'string' ? v.charCodeAt(0) : 0)
        for (let i = 0; i < sig.length; i++) { h ^= sig.charCodeAt(i); h = (h * 16777619) >>> 0 }
      }
      const sessionId = sessionIdRef.current
      const mapSig = `${h}:${Object.keys(built.map).length}`
      const firstRun = !iframeInitialized.current

      if (!firstRun && prevMapHash.current === mapSig) return

      const ok = await publishPreview(sessionId, built.map)
      if (!ok) {
        console.warn('[Preview] publishPreview failed — falling back to blob')
        setSwReady(false)
        return
      }

      // Proactive probe: verify the SW actually intercepts our virtual
      // URL. If Netlify's SPA fallback (_redirects) catches it instead,
      // we'd load the main React app in the iframe which then blows up
      // with CORS errors. We now return 404 on those paths, so anything
      // other than a 200-text/html response means the SW isn't on.
      try {
        const probeUrl = previewUrl(sessionId, built.entry)
        const probe = await fetch(probeUrl, { cache: 'no-store' })
        const ct = probe.headers.get('content-type') || ''
        if (!probe.ok || !/html/i.test(ct)) {
          console.warn('[Preview] SW probe failed — status:', probe.status, 'ct:', ct)
          setSwReady(false)
          return
        }
      } catch (err) {
        console.warn('[Preview] SW probe error — falling back to blob:', err)
        setSwReady(false)
        return
      }

      prevMapHash.current = mapSig
      // On first run: point iframe at the entry page. On refresh-key bump:
      // reload via cache-bust. On subsequent file changes: leave iframe
      // alone unless it's still on the entry page (the user may have
      // clicked through to about.html and we don't want to yank them
      // back to index every time CSS changes). Native navigation inside
      // the iframe continues to work because SW has the fresh files.
      if (firstRun) {
        iframeInitialized.current = true
        initialRefreshKeyRef.current = refreshKey
        iframeRef.current.src = previewUrl(sessionId, built.entry)
      } else if (refreshKey !== initialRefreshKeyRef.current) {
        // User hit refresh — force full reload of whatever page the
        // iframe is currently on. currentPage is kept in sync by the
        // SW_PAGE_REPORTER script injected into each served HTML.
        initialRefreshKeyRef.current = refreshKey
        const page = currentPage === 'index' ? built.entry : currentPage + '.html'
        iframeRef.current.src = previewUrl(sessionId, page) + '?v=' + Date.now()
      }
    }, 400)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [swReady, files, refreshKey, previewMode, buildSWFileMap, currentPage])

  // ─── Blob fallback (only runs when SW isn't ready) ──────────────────
  useEffect(() => {
    if (swReady) return // SW path above is authoritative once ready
    if (previewMode === 'dev-server' || previewMode === 'none') return
    if (!iframeRef.current) return

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      if (!iframeRef.current) return

      let html: string | null = null

      if (previewMode === 'build') {
        let pageHtml: string | null = null
        if (currentPage === 'index') {
          pageHtml = distIndexHtml
        } else {
          pageHtml = findPageHtml(currentPage)
        }
        if (!pageHtml) pageHtml = distIndexHtml
        if (pageHtml) html = buildPageHtml(pageHtml)
      } else if (previewMode === 'static' && htmlFile) {
        html = buildFullHtml(htmlFile)
      }

      if (!html) return

      let h = 2166136261
      for (let i = 0; i < html.length; i++) {
        h ^= html.charCodeAt(i)
        h = (h * 16777619) >>> 0
      }
      const hashKey = `${h}:${currentPage}`
      if (prevHtmlHash.current === hashKey) return
      prevHtmlHash.current = hashKey

      let finalHtml = html
      if (!/<meta[^>]+charset/i.test(finalHtml)) {
        if (/<head[^>]*>/i.test(finalHtml)) {
          finalHtml = finalHtml.replace(/<head([^>]*)>/i, '<head$1><meta charset="UTF-8">')
        } else if (/<html[^>]*>/i.test(finalHtml)) {
          finalHtml = finalHtml.replace(/<html([^>]*)>/i, '<html$1><head><meta charset="UTF-8"></head>')
        } else {
          finalHtml = '<meta charset="UTF-8">\n' + finalHtml
        }
      }

      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current)
      const blob = new Blob([finalHtml], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      prevBlobUrl.current = url
      iframeRef.current.src = url
    }, 600)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [swReady, htmlFile, distIndexHtml, files, refreshKey, previewMode, currentPage, buildFullHtml, buildPageHtml, findPageHtml])

  // Build a self-contained multi-page HTML for "open in new tab"
  // All pages are embedded with a hash router (#about, #projects, etc.)
  const buildFullSiteBlob = useCallback((): string | null => {
    // Collect candidate pages (name → processed HTML).
    //
    // In STATIC mode the navigation intercept used by the in-iframe preview
    // talks to `window.parent` via postMessage — which doesn't exist in a
    // standalone tab. So without this branch, clicking "kontakt" in the
    // opened tab would do absolutely nothing. We detect the multi-page
    // case (index.html + kontakt.html + usluge.html …) and bundle them
    // into the same hash-router shell we use for multi-page builds.
    const pages: Record<string, string> = {}

    if (previewMode === 'static' && htmlFile) {
      for (const [path, content] of Object.entries(files)) {
        if (!/\.html?$/i.test(path)) continue
        if (path.startsWith('dist/') || path.startsWith('out/')) continue
        if (path.includes('node_modules/')) continue
        if (path.includes('/')) continue // top-level pages only
        let pageName = path.replace(/\.html?$/, '')
        if (!pageName || pageName === 'index') pageName = 'index'
        pages[pageName] = buildFullHtml(content)
      }
      if (Object.keys(pages).length === 0) {
        return buildFullHtml(htmlFile)
      }
      if (Object.keys(pages).length === 1 && pages['index']) {
        return pages['index']
      }
      // fall through to multi-page wrapper
    } else if (previewMode === 'build' && distIndexHtml) {
      const prefix = buildDir + '/'
      for (const [path, content] of Object.entries(files)) {
        if (!path.startsWith(prefix) || !path.endsWith('.html')) continue
        let pageName = path.slice(prefix.length).replace(/\.html$/, '').replace(/\/index$/, '')
        if (!pageName) pageName = 'index'
        pages[pageName] = buildPageHtml(content)
      }
      if (Object.keys(pages).length <= 1 && pages['index']) {
        return pages['index']
      }
    } else {
      return null
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
          {(previewMode === 'build' || (swReady && previewMode === 'static')) && currentPage !== 'index' && (
            <button
              className="preview-action-btn"
              onClick={() => {
                setCurrentPage('index')
                // SW mode: iframe is on a different page via native nav,
                // so setCurrentPage alone won't bring it back. Point src
                // at index and let it reload.
                if (swReady && iframeRef.current) {
                  iframeRef.current.src = previewUrl(sessionIdRef.current, 'index.html') + '?v=' + Date.now()
                }
              }}
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
                  const withCharset = /<meta[^>]+charset/i.test(fullSite)
                    ? fullSite
                    : fullSite.replace(/<head([^>]*)>/i, '<head$1><meta charset="UTF-8">')
                  const blob = new Blob([withCharset], { type: 'text/html;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  window.open(url, '_blank')
                  // Browsers hold the blob as long as any tab references it,
                  // so we can safely release our URL handle after a short
                  // delay. Without this, every "open in new tab" click
                  // leaks a few hundred KB of HTML for the life of the tab.
                  setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
