/**
 * Preview server client.
 *
 * Companion to /public/vajb-preview-sw.js. Registers the worker once,
 * publishes file maps keyed by session id, and hands out virtual URLs
 * the preview iframe can load.
 *
 * Call sites:
 *   - ensurePreviewServer()  — idempotent; registers + waits for active SW.
 *   - publishPreview(sid, files) — pushes a file map into the worker.
 *   - previewUrl(sid, page) — builds `/__vajb_preview/<sid>/<page>`.
 *   - previewSessionId() — random, url-safe session id for a panel instance.
 *
 * A session id is just a scratch namespace so we can run multiple tabs
 * without crosstalk. We don't bother clearing sessions — the worker
 * only keeps them in memory and they vanish when the SW is suspended.
 */

const SW_PATH = '/vajb-preview-sw.js'
export const PREVIEW_PREFIX = '/__vajb_preview/'

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null

/** Captured at module load — used to detect whether we can still safely
 *  force-reload. If the user has interacted, navigated, or even just sat
 *  long enough for React to fully mount, we bail. */
const moduleLoadTime = typeof performance !== 'undefined' ? performance.now() : Date.now()

/**
 * Register the preview service worker if it isn't already. Resolves with
 * the registration once an active worker exists, or null if the browser
 * doesn't support service workers / registration failed.
 *
 * Safe to call repeatedly — all callers share the same promise.
 */
export function ensurePreviewServer(): Promise<ServiceWorkerRegistration | null> {
  if (registrationPromise) return registrationPromise
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    registrationPromise = Promise.resolve(null)
    return registrationPromise
  }

  registrationPromise = (async () => {
    try {
      const existing = await navigator.serviceWorker.getRegistration(SW_PATH)
      const reg = existing ?? await navigator.serviceWorker.register(SW_PATH, { scope: '/' })

      // Wait for an active worker (install → activate).
      if (!reg.active) {
        const pending = reg.installing || reg.waiting
        if (pending) {
          await new Promise<void>((resolve) => {
            const check = () => {
              if (pending.state === 'activated' || pending.state === 'redundant') resolve()
            }
            pending.addEventListener('statechange', check)
            check()
          })
        }
      }

      // CRITICAL: wait until the SW actually *controls* this page.
      // Without this, fetches to /__vajb_preview/... bypass the worker
      // and hit Netlify, which returns the SPA fallback (our React app)
      // inside the preview iframe. On first visit, clients.claim() fires
      // controllerchange; on revisits, navigator.serviceWorker.controller
      // is usually set before we even get here.
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          const done = () => resolve()
          const timer = setTimeout(done, 3000) // hard cap so UI doesn't hang
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(timer)
            done()
          }, { once: true })
        })
      }

      // Still no controller? The page was loaded before the SW claimed it
      // (common on first install). If we're still within the first ~2s of
      // page load we CAN safely force a silent reload — the user hasn't
      // had time to click anything or start typing. Past that window we
      // leave it alone and let PreviewPanel's blob fallback take over, so
      // we never nuke in-flight user input.
      if (reg.active && !navigator.serviceWorker.controller) {
        try {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
          const elapsed = now - moduleLoadTime
          const RELOAD_KEY = 'vajb_sw_bootstrap_reloaded'
          const hasInteracted = document.querySelector('textarea, input[type="text"]') &&
            (document.querySelector('textarea')?.value || '').length > 0
          if (elapsed < 2000 && !sessionStorage.getItem(RELOAD_KEY) && !hasInteracted) {
            sessionStorage.setItem(RELOAD_KEY, '1')
            console.info('[previewServer] SW active but not controlling — one-time silent reload to claim (boot window)')
            window.location.reload()
            await new Promise(() => {}) // never resolves; reload tears the module down
          }
        } catch {
          // sessionStorage or DOM query can throw in weird envs — just
          // skip the auto-reload and fall back to blob preview path.
        }
      }
      return reg
    } catch (err) {
      console.warn('[previewServer] SW registration failed:', err)
      return null
    }
  })()

  return registrationPromise
}

/**
 * Push a file map to the preview worker. Returns true if the worker
 * acknowledged the publish within 2 seconds.
 *
 * File values can be:
 *   - plain text (html/css/js/json/…)
 *   - data: URLs (decoded on the fly)
 *   - https:// URLs (fetched through when requested — used for R2 assets)
 */
export async function publishPreview(sid: string, files: Record<string, string>): Promise<boolean> {
  const reg = await ensurePreviewServer()
  const worker = reg?.active || navigator.serviceWorker?.controller
  if (!worker) return false

  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(false), 2000)
    channel.port1.onmessage = (e) => {
      clearTimeout(timer)
      resolve(!!(e.data && e.data.ok))
    }
    try {
      worker.postMessage({ type: 'vajb-publish', sid, files }, [channel.port2])
    } catch (err) {
      clearTimeout(timer)
      console.warn('[previewServer] publish failed:', err)
      resolve(false)
    }
  })
}

/** Build the virtual URL the iframe should load for a given page. */
export function previewUrl(sid: string, page = 'index.html'): string {
  const normalized = page.replace(/^\/+/, '')
  return `${PREVIEW_PREFIX}${encodeURIComponent(sid)}/${normalized}`
}

/** Short, url-safe session id unique per preview panel instance. */
export function previewSessionId(): string {
  // 12 chars of base36 randomness + timestamp suffix — plenty for
  // collision-freedom across tabs, stays short in URLs.
  const rnd = Math.random().toString(36).slice(2, 10)
  const ts = Date.now().toString(36).slice(-4)
  return `p${rnd}${ts}`
}
