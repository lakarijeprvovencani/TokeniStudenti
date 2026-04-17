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
      // Wait for an active + controlling worker. On the very first visit the
      // page that *installed* the SW doesn't get controlled until reload —
      // but publishPreview works via postMessage so that's fine as long as
      // reg.active exists.
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
