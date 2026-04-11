const NETLIFY_API = 'https://api.netlify.com/api/v1'
const VERCEL_API = 'https://api.vercel.com'

export interface DeployResult {
  success: boolean
  url?: string
  error?: string
}

/**
 * Deploy fajlove na Netlify.
 * Ako ima token (iz podešavanja), koristi korisnikov nalog.
 * Ako nema, koristi Netlify Drop (anonimni deploy, traje 24h).
 */
export async function deployToNetlify(
  files: Record<string, string>,
  token?: string
): Promise<DeployResult> {
  try {
    // Napravi finalni HTML sa ubačenim CSS/JS
    const htmlFile = files['index.html'] || files['index.htm']
    if (!htmlFile) {
      return { success: false, error: 'Nema index.html fajla za deploy.' }
    }

    // Kreiraj ZIP sa svim fajlovima
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()

    // Ubaci sve fajlove u ZIP
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith('/')) {
        zip.file(path, content)
      }
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' })

    if (token) {
      // Deploy sa tokenom na korisnikov Netlify nalog
      // Kreiraj novi sajt
      const siteRes = await fetch(`${NETLIFY_API}/sites`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/zip',
        },
        body: zipBlob,
      })

      if (!siteRes.ok) {
        const err = await siteRes.text()
        return { success: false, error: `Netlify greška: ${siteRes.status} ${err.substring(0, 100)}` }
      }

      const site = await siteRes.json()
      return { success: true, url: site.ssl_url || site.url }
    } else {
      // Anonimni deploy preko Netlify Drop API
      const res = await fetch(`${NETLIFY_API}/sites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
        },
        body: zipBlob,
      })

      if (!res.ok) {
        const err = await res.text()
        return { success: false, error: `Deploy greška: ${res.status} ${err.substring(0, 100)}` }
      }

      const site = await res.json()
      return { success: true, url: site.ssl_url || site.url }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Nepoznata greška pri deploy-u',
    }
  }
}

/**
 * Deploy fajlove na Vercel.
 * Zahteva Vercel access token iz podešavanja.
 */
export async function deployToVercel(
  files: Record<string, string>,
  token: string
): Promise<DeployResult> {
  try {
    const fileList = Object.entries(files)
      .filter(([path]) => !path.endsWith('/') && !path.includes('node_modules/'))
      .map(([file, data]) => ({ file, data }))

    if (fileList.length === 0) {
      return { success: false, error: 'Nema fajlova za deploy.' }
    }

    const res = await fetch(`${VERCEL_API}/v13/deployments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'vajbagent-project',
        files: fileList,
        projectSettings: { framework: null },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return { success: false, error: `Vercel greška: ${res.status} ${err.substring(0, 100)}` }
    }

    const data = await res.json()
    return { success: true, url: `https://${data.url}` }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Nepoznata greška pri deploy-u na Vercel',
    }
  }
}
