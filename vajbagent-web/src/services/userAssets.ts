/**
 * User-uploaded image assets for the current project.
 *
 * Storage tiers (in order of preference):
 *   1. WebContainer virtual filesystem — binary file for instant preview.
 *   2. Cloudflare R2 via backend presigned URL — persistent cloud storage.
 *      files[path] stores the public R2 URL after upload.
 *   3. data URL in React state (fallback) — used when R2 is unavailable
 *      or during the upload window before R2 completes.
 */

import { resizeImageFile } from './imageResize'
import { writeBinaryFile } from './webcontainer'
import { signUpload, commitUpload } from './remoteProjectStore'

/** Hard cap on images per project. 20 is plenty for landing / portfolio / menu sites. */
export const MAX_IMAGES_PER_PROJECT = 20
/** Max post-resize size per single image. 20MB phone shots become ~700KB so this basically never trips. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** Max total image size per project, keeps IndexedDB quota safe. */
export const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif']

export interface UploadedImage {
  /** Path in the WC filesystem + in SavedProject.files (e.g. "public/hero.jpg") */
  path: string
  /** Full data URL (data:image/jpeg;base64,...) — used to re-hydrate on resume */
  dataUrl: string
  /** Approx byte size (decoded from dataUrl) */
  bytes: number
}

export interface UploadResult {
  added: UploadedImage[]
  skipped: { name: string; reason: string }[]
}

/** Slugify a filename: lowercase, ASCII-only, keeps extension. */
function slugifyName(raw: string): string {
  const lastDot = raw.lastIndexOf('.')
  const base = lastDot >= 0 ? raw.slice(0, lastDot) : raw
  const ext = lastDot >= 0 ? raw.slice(lastDot + 1).toLowerCase() : ''
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'slika'
  const safeExt = IMAGE_EXTS.includes(ext) ? ext : 'jpg'
  return `${slug}.${safeExt}`
}

/** Approx decoded byte count from a data URL. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return dataUrl.length
  return Math.floor((dataUrl.length - comma - 1) * 0.75)
}

/** Convert data URL → Uint8Array for the WebContainer fs write. */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const meta = dataUrl.slice(5, comma)       // "image/png;base64"
  const isBase64 = meta.endsWith(';base64')
  const payload = dataUrl.slice(comma + 1)
  try {
    if (isBase64) {
      const bin = atob(payload)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }
    // URL-encoded (common for SVG) — pass through TextEncoder
    return new TextEncoder().encode(decodeURIComponent(payload))
  } catch {
    return null
  }
}

/** Does this filename in files{} already exist? */
function pathExists(files: Record<string, string>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, path)
}

/** Find a non-conflicting filename: `hero.jpg` → `hero-2.jpg` → `hero-3.jpg` ... */
function resolveConflict(files: Record<string, string>, targetPath: string): string {
  if (!pathExists(files, targetPath)) return targetPath
  const lastSlash = targetPath.lastIndexOf('/')
  const dir = lastSlash >= 0 ? targetPath.slice(0, lastSlash + 1) : ''
  const fileName = lastSlash >= 0 ? targetPath.slice(lastSlash + 1) : targetPath
  const lastDot = fileName.lastIndexOf('.')
  const base = lastDot >= 0 ? fileName.slice(0, lastDot) : fileName
  const ext = lastDot >= 0 ? fileName.slice(lastDot) : ''
  for (let n = 2; n < 100; n++) {
    const candidate = `${dir}${base}-${n}${ext}`
    if (!pathExists(files, candidate)) return candidate
  }
  return `${dir}${base}-${Date.now()}${ext}`
}

/** Count how many existing entries in files{} look like user-uploaded images. */
export function countImages(files: Record<string, string>): number {
  let n = 0
  for (const path of Object.keys(files)) {
    if (path.endsWith('/')) continue
    const ext = path.split('.').pop()?.toLowerCase() || ''
    if (IMAGE_EXTS.includes(ext)) n++
  }
  return n
}

/** Sum of approximate bytes of all image entries in files{}. */
export function totalImageBytes(files: Record<string, string>): number {
  let total = 0
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    const ext = path.split('.').pop()?.toLowerCase() || ''
    if (!IMAGE_EXTS.includes(ext)) continue
    if (typeof content === 'string' && content.startsWith('data:')) {
      total += dataUrlBytes(content)
    } else if (typeof content === 'string') {
      total += content.length
    }
  }
  return total
}

/**
 * Process a batch of picked/dropped/pasted files into the project.
 * Returns which ones were added and which were skipped with a reason.
 * The caller is responsible for:
 *   - Merging `added` into the React `files` state
 *   - Displaying error toasts for `skipped`
 */
export async function addImageFiles(
  rawFiles: File[],
  currentFiles: Record<string, string>,
): Promise<UploadResult> {
  const added: UploadedImage[] = []
  const skipped: { name: string; reason: string }[] = []

  // Snapshot of files that grows as we accept more in this batch, so
  // filename conflict resolution sees the in-progress batch too.
  const workingFiles: Record<string, string> = { ...currentFiles }

  let existingCount = countImages(workingFiles)
  let existingBytes = totalImageBytes(workingFiles)

  for (const file of rawFiles) {
    if (!file.type.startsWith('image/')) {
      skipped.push({ name: file.name, reason: 'Nije slika' })
      continue
    }
    if (existingCount >= MAX_IMAGES_PER_PROJECT) {
      skipped.push({ name: file.name, reason: `Limit ${MAX_IMAGES_PER_PROJECT} slika po projektu` })
      continue
    }
    const resized = await resizeImageFile(file)
    if (!resized) {
      skipped.push({ name: file.name, reason: 'Ne mogu da pročitam sliku' })
      continue
    }
    if (resized.finalBytes > MAX_IMAGE_BYTES) {
      skipped.push({ name: file.name, reason: 'Slika prevelika i nakon kompresije' })
      continue
    }
    if (existingBytes + resized.finalBytes > MAX_TOTAL_IMAGE_BYTES) {
      skipped.push({ name: file.name, reason: 'Prekoračen ukupni prostor za slike' })
      continue
    }

    const desiredPath = `public/${slugifyName(resized.name)}`
    const finalPath = resolveConflict(workingFiles, desiredPath)

    // Write binary into the WebContainer so preview sees it immediately.
    const bytes = dataUrlToBytes(resized.dataUrl)
    if (!bytes) {
      skipped.push({ name: file.name, reason: 'Neispravan format slike' })
      continue
    }
    try {
      await writeBinaryFile(finalPath, bytes)
    } catch (err) {
      console.warn('[userAssets] WC writeBinaryFile failed:', err)
      skipped.push({ name: file.name, reason: 'WebContainer nije spreman' })
      continue
    }

    // And store the data URL in the React files map so IndexedDB save
    // picks it up and we can re-hydrate next session.
    workingFiles[finalPath] = resized.dataUrl
    existingCount++
    existingBytes += resized.finalBytes
    added.push({ path: finalPath, dataUrl: resized.dataUrl, bytes: resized.finalBytes })
  }

  return { added, skipped }
}

/**
 * Re-inflate user-upload images from the persisted project back into WC fs.
 * Handles both data URLs (legacy/offline) and R2 public URLs (cloud).
 */
export async function hydrateImagesIntoWc(files: Record<string, string>): Promise<void> {
  const tasks: Promise<void>[] = []

  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    if (!isImagePath(path)) continue
    if (typeof content !== 'string') continue

    if (isR2Url(content)) {
      tasks.push(
        fetch(content)
          .then(r => r.arrayBuffer())
          .then(buf => writeBinaryFile(path, new Uint8Array(buf)))
          .catch(err => console.warn('[userAssets] hydrate from R2 failed:', path, err))
      )
    } else if (isDataUrl(content)) {
      const bytes = dataUrlToBytes(content)
      if (!bytes) continue
      tasks.push(
        writeBinaryFile(path, bytes)
          .catch(err => console.warn('[userAssets] hydrate from dataUrl failed:', path, err))
      )
    }
  }

  await Promise.allSettled(tasks)
}

export function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXTS.includes(ext)
}

export function isR2Url(value: string): boolean {
  return typeof value === 'string' && (
    value.startsWith('https://') && value.includes('.r2.') ||
    value.startsWith('https://') && value.includes('cloudflarestorage')
  )
}

export function isDataUrl(value: string): boolean {
  return typeof value === 'string' && value.startsWith('data:')
}

/**
 * Upload a single data-URL image to R2 via the backend presign flow.
 * Returns the public R2 URL, or null if the upload fails (caller keeps data URL).
 */
export async function uploadImageToR2(
  projectId: string,
  filePath: string,
  dataUrl: string,
): Promise<string | null> {
  const bytes = dataUrlToBytes(dataUrl)
  if (!bytes) return null

  const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg'
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    avif: 'image/avif', ico: 'image/x-icon',
  }
  const contentType = mimeMap[ext] || 'application/octet-stream'

  try {
    const { uploadUrl, r2Key } = await signUpload(projectId, filePath, contentType, bytes.length)

    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    })
    if (!putResp.ok) {
      console.warn('[userAssets] R2 PUT failed:', putResp.status)
      return null
    }

    const { url } = await commitUpload(projectId, r2Key, filePath)
    return url
  } catch (err) {
    console.warn('[userAssets] R2 upload failed for', filePath, err)
    return null
  }
}

/**
 * Scan all image entries in a project's files and upload any data URLs to R2.
 * Returns a new files map with data URLs replaced by R2 URLs.
 */
export async function uploadAllImagesToR2(
  projectId: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const updated = { ...files }
  const pending: Promise<void>[] = []

  for (const [path, content] of Object.entries(files)) {
    if (!isImagePath(path)) continue
    if (!isDataUrl(content)) continue

    pending.push(
      uploadImageToR2(projectId, path, content).then(url => {
        if (url) updated[path] = url
      })
    )
  }

  await Promise.allSettled(pending)
  return updated
}
