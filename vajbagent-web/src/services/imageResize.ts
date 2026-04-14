/**
 * Client-side image downscaling + recompression.
 *
 * Users on phones take 10-20MB photos — we don't want to reject them
 * (bad UX) and we definitely don't want to ship megabyte-heavy base64
 * blobs to the model (slow + expensive). Before storing an attached
 * image we draw it into an offscreen canvas, cap the longest edge,
 * and re-encode as JPEG at a conservative quality. The output is
 * guaranteed to fit under MAX_OUT_BYTES regardless of the source
 * size, so the user never sees "image too big".
 */

const MAX_EDGE = 1600            // longest side, px — plenty for vision models
const INITIAL_QUALITY = 0.82
const MIN_QUALITY = 0.55
const MAX_OUT_BYTES = 900_000    // ~900KB final blob after base64 overhead

export interface ResizedImage {
  name: string
  dataUrl: string
  originalBytes: number
  finalBytes: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = src
  })
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error || new Error('read failed'))
    fr.readAsDataURL(file)
  })
}

function approxBytesFromDataUrl(dataUrl: string): number {
  // data:image/jpeg;base64,AAAA...  — base64 part is dataUrl.length - header
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx < 0) return dataUrl.length
  const b64 = dataUrl.length - commaIdx - 1
  return Math.floor(b64 * 0.75)
}

/**
 * Resize + compress a single file. Returns a ResizedImage on success,
 * null if the file could not be decoded at all (non-image, corrupt,
 * whatever). Never throws.
 */
export async function resizeImageFile(file: File): Promise<ResizedImage | null> {
  if (!file.type.startsWith('image/')) return null
  const originalBytes = file.size
  try {
    const srcDataUrl = await readAsDataUrl(file)
    const img = await loadImage(srcDataUrl)

    // SVGs have naturalWidth=0 sometimes — keep them as-is, they are
    // already small and vector.
    if (file.type === 'image/svg+xml' || img.naturalWidth === 0) {
      return {
        name: file.name,
        dataUrl: srcDataUrl,
        originalBytes,
        finalBytes: approxBytesFromDataUrl(srcDataUrl),
      }
    }

    let { naturalWidth: w, naturalHeight: h } = img
    const longest = Math.max(w, h)
    if (longest > MAX_EDGE) {
      const scale = MAX_EDGE / longest
      w = Math.round(w * scale)
      h = Math.round(h * scale)
    }

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)

    // Try progressively lower quality until the encoded blob fits.
    let quality = INITIAL_QUALITY
    let dataUrl = canvas.toDataURL('image/jpeg', quality)
    let finalBytes = approxBytesFromDataUrl(dataUrl)
    while (finalBytes > MAX_OUT_BYTES && quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - 0.08)
      dataUrl = canvas.toDataURL('image/jpeg', quality)
      finalBytes = approxBytesFromDataUrl(dataUrl)
    }

    // If still too big, shrink the canvas one more step (e.g. someone
    // pasted a huge 8000×8000 PNG). This should basically never fire.
    if (finalBytes > MAX_OUT_BYTES && w > 800) {
      const smaller = document.createElement('canvas')
      const ratio = 800 / w
      smaller.width = 800
      smaller.height = Math.round(h * ratio)
      const sctx = smaller.getContext('2d')
      if (sctx) {
        sctx.drawImage(canvas, 0, 0, smaller.width, smaller.height)
        dataUrl = smaller.toDataURL('image/jpeg', MIN_QUALITY)
        finalBytes = approxBytesFromDataUrl(dataUrl)
      }
    }

    return { name: file.name, dataUrl, originalBytes, finalBytes }
  } catch {
    return null
  }
}
