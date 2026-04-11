const GITHUB_API = 'https://api.github.com'

export interface GitHubResult {
  success: boolean
  url?: string
  error?: string
}

export async function pushToGitHub(
  files: Record<string, string>,
  token: string,
  repo: string
): Promise<GitHubResult> {
  try {
    const headers: Record<string, string> = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    }

    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) {
      return { success: false, error: 'Format mora biti: username/repo-name' }
    }

    // Check if repo exists
    const repoCheck = await fetch(`${GITHUB_API}/repos/${repo}`, { headers })
    if (repoCheck.status === 404) {
      // Create repository
      const createRes = await fetch(`${GITHUB_API}/user/repos`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: repoName, auto_init: true, private: false }),
      })
      if (!createRes.ok) {
        const err = await createRes.text()
        return { success: false, error: `Greška pri kreiranju repozitorijuma: ${err.substring(0, 100)}` }
      }
      // Wait for repo to initialize
      await new Promise(r => setTimeout(r, 2000))
    } else if (!repoCheck.ok) {
      return { success: false, error: 'Ne mogu da pristupim repozitorijumu. Proveri token i ime.' }
    }

    // Get default branch
    const repoInfo = await fetch(`${GITHUB_API}/repos/${repo}`, { headers })
    if (!repoInfo.ok) {
      return { success: false, error: 'Ne mogu da učitam informacije o repozitorijumu.' }
    }
    const repoData = await repoInfo.json()
    const defaultBranch = repoData.default_branch || 'main'

    // Get latest commit SHA
    const refRes = await fetch(`${GITHUB_API}/repos/${repo}/git/refs/heads/${defaultBranch}`, { headers })
    if (!refRes.ok) {
      return { success: false, error: 'Ne mogu da nađem granu. Proveri da repozitorijum ima barem jedan commit.' }
    }
    const refData = await refRes.json()
    const latestCommitSha = refData.object.sha

    // Get base tree
    const commitRes = await fetch(`${GITHUB_API}/repos/${repo}/git/commits/${latestCommitSha}`, { headers })
    const commitData = await commitRes.json()
    const baseTreeSha = commitData.tree.sha

    // Create blobs for each file
    const tree: { path: string; mode: string; type: string; sha: string }[] = []

    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith('/')) continue
      if (path.includes('node_modules/')) continue

      const blobRes = await fetch(`${GITHUB_API}/repos/${repo}/git/blobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content, encoding: 'utf-8' }),
      })

      if (!blobRes.ok) continue
      const blobData = await blobRes.json()

      tree.push({ path, mode: '100644', type: 'blob', sha: blobData.sha })
    }

    if (tree.length === 0) {
      return { success: false, error: 'Nema fajlova za push.' }
    }

    // Create tree
    const treeRes = await fetch(`${GITHUB_API}/repos/${repo}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    })
    if (!treeRes.ok) {
      return { success: false, error: 'Greška pri kreiranju stabla fajlova.' }
    }
    const treeData = await treeRes.json()

    // Create commit
    const newCommitRes = await fetch(`${GITHUB_API}/repos/${repo}/git/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: 'Update from VajbAgent',
        tree: treeData.sha,
        parents: [latestCommitSha],
      }),
    })
    if (!newCommitRes.ok) {
      return { success: false, error: 'Greška pri kreiranju commit-a.' }
    }
    const newCommitData = await newCommitRes.json()

    // Update ref
    const updateRefRes = await fetch(`${GITHUB_API}/repos/${repo}/git/refs/heads/${defaultBranch}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: newCommitData.sha }),
    })
    if (!updateRefRes.ok) {
      return { success: false, error: 'Greška pri ažuriranju grane.' }
    }

    return { success: true, url: `https://github.com/${repo}` }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Nepoznata greška pri push-u na GitHub',
    }
  }
}
