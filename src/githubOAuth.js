/**
 * GitHub OAuth integration.
 * Lets users connect their GitHub account so VajbAgent can create repos
 * and push code with one click.
 */

import crypto from 'crypto';
import { getRedis } from './redis.js';

const CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || '';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

const REDIRECT_URI = process.env.GITHUB_OAUTH_REDIRECT_URI || 'https://vajbagent.com/auth/github/callback';

// Scopes: repo (full repo access — needed to create + push to private repos),
// read:user (basic profile info)
const SCOPES = 'repo read:user user:email';

const stateStore = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of stateStore) {
    if (data.expires < now) stateStore.delete(token);
  }
}, 60_000).unref?.();

export function isGitHubOAuthConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ─── Token storage ───────────────────────────────────────────────────────────

async function saveToken(studentKey, tokenData) {
  const redis = getRedis();
  if (!redis) {
    console.warn('[GitHubOAuth] Redis not configured');
    return;
  }
  const key = `vajb:github:tokens:${studentKey}`;
  await redis.set(key, JSON.stringify(tokenData));
}

async function loadToken(studentKey) {
  const redis = getRedis();
  if (!redis) return null;
  const key = `vajb:github:tokens:${studentKey}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

async function deleteToken(studentKey) {
  const redis = getRedis();
  if (!redis) return;
  const key = `vajb:github:tokens:${studentKey}`;
  await redis.del(key);
}

// ─── OAuth flow ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(studentKey) {
  if (!isGitHubOAuthConfigured()) {
    throw new Error('GitHub OAuth not configured');
  }
  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { studentKey, expires: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    allow_signup: 'true',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function handleCallback(code, state, expectedStudentKey) {
  if (!code || !state) throw new Error('Missing code or state');

  const stateData = stateStore.get(state);
  if (!stateData) throw new Error('Invalid or expired state');
  stateStore.delete(state);
  if (stateData.expires < Date.now()) throw new Error('State expired');

  // Prevent OAuth login-CSRF: the callback must come from the same user
  // session that started the flow. Otherwise an attacker could start a flow
  // on their account, send the consent URL to a victim, and bind the victim's
  // GitHub account to the attacker's student key.
  if (expectedStudentKey && stateData.studentKey !== expectedStudentKey) {
    throw new Error('Session mismatch — initiator and callback are different users');
  }

  // Exchange code for access token
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  if (data.error) throw new Error(`OAuth error: ${data.error_description || data.error}`);
  if (!data.access_token) throw new Error('No access_token in response');

  // Fetch user info to store username
  const userResp = await fetch(`${API_BASE}/user`, {
    headers: {
      'Authorization': `Bearer ${data.access_token}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  const user = userResp.ok ? await userResp.json() : {};

  await saveToken(stateData.studentKey, {
    access_token: data.access_token,
    scope: data.scope,
    token_type: data.token_type,
    username: user.login || null,
    name: user.name || null,
    avatar_url: user.avatar_url || null,
  });

  return { studentKey: stateData.studentKey, username: user.login };
}

export async function isConnected(studentKey) {
  const t = await loadToken(studentKey);
  return !!t;
}

export async function getConnectionInfo(studentKey) {
  const t = await loadToken(studentKey);
  if (!t) return null;
  return {
    username: t.username,
    name: t.name,
    avatar_url: t.avatar_url,
  };
}

export async function disconnect(studentKey) {
  await deleteToken(studentKey);
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function ghApi(studentKey, method, path, body) {
  const t = await loadToken(studentKey);
  if (!t) throw new Error('Not connected to GitHub');

  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${t.access_token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${path} failed: ${resp.status} ${errText.substring(0, 300)}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

/** List user's repositories */
export async function listRepos(studentKey) {
  return ghApi(studentKey, 'GET', '/user/repos?sort=updated&per_page=50');
}

/** Create a new repo on the user's account */
export async function createRepo(studentKey, { name, description, isPrivate = false }) {
  return ghApi(studentKey, 'POST', '/user/repos', {
    name,
    description: description || `Created with VajbAgent`,
    private: isPrivate,
    auto_init: true,
  });
}

/** Get authenticated user's username */
async function getUsername(studentKey) {
  const t = await loadToken(studentKey);
  if (t?.username) return t.username;
  const user = await ghApi(studentKey, 'GET', '/user');
  return user.login;
}

/**
 * Push files to a repository.
 * Creates blobs, builds tree, creates commit, updates branch ref.
 * If repo doesn't exist, creates it first.
 */
export async function pushFiles(studentKey, { repo, files, message = 'Update from VajbAgent', branch = 'main', createIfMissing = true }) {
  if (!repo || !files) throw new Error('repo and files required');

  // Resolve repo: support "owner/name" or just "name" (uses authenticated user)
  let owner, repoName;
  if (repo.includes('/')) {
    [owner, repoName] = repo.split('/');
  } else {
    owner = await getUsername(studentKey);
    repoName = repo;
  }

  // Check if repo exists, create if needed
  let repoExists = true;
  try {
    await ghApi(studentKey, 'GET', `/repos/${owner}/${repoName}`);
  } catch (err) {
    if (String(err.message).includes('404')) {
      repoExists = false;
    } else {
      throw err;
    }
  }

  if (!repoExists) {
    if (!createIfMissing) throw new Error(`Repo ${owner}/${repoName} does not exist`);
    await createRepo(studentKey, { name: repoName, isPrivate: false });
    // Wait briefly for repo to be ready
    await new Promise(r => setTimeout(r, 1000));
  }

  // Get current branch ref
  let parentSha = null;
  let baseTreeSha = null;
  try {
    const ref = await ghApi(studentKey, 'GET', `/repos/${owner}/${repoName}/git/refs/heads/${branch}`);
    parentSha = ref.object.sha;
    const commit = await ghApi(studentKey, 'GET', `/repos/${owner}/${repoName}/git/commits/${parentSha}`);
    baseTreeSha = commit.tree.sha;
  } catch {
    // Empty repo or branch doesn't exist — that's fine, we'll create the first commit
  }

  // Create blobs for all files
  const blobs = {};
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    // Skip build artifacts, VCS dirs, IDE config, and SECRETS
    if (/^(node_modules|\.git|dist|out|build|\.next|\.nuxt|\.cache|\.turbo|\.vercel|\.netlify|coverage|\.idea|\.vscode)\//.test(path)) continue;
    const base = path.split('/').pop() || path;
    // Never push environment files or credential files (defense-in-depth —
    // frontend also filters, but backend MUST enforce independently)
    if (/^\.env(\..*)?$/.test(base)) continue;
    if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(base)) continue;
    if (/^(service-account|firebase-credentials|credentials|secrets)(\..+)?\.json$/i.test(base)) continue;
    if (/^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/.test(base)) continue;
    if (typeof content !== 'string') continue;

    // User-uploaded binary assets (images, fonts) arrive as data URLs
    // from the frontend. GitHub's blob API accepts base64 directly —
    // strip the data URL prefix and forward the raw base64 so the image
    // lands in the repo as a real binary, not a text dump.
    let blob;
    if (content.startsWith('data:')) {
      const commaIdx = content.indexOf(',');
      const header = commaIdx >= 0 ? content.slice(5, commaIdx) : '';
      const isBase64 = header.includes(';base64');
      const payload = commaIdx >= 0 ? content.slice(commaIdx + 1) : '';
      if (isBase64) {
        blob = await ghApi(studentKey, 'POST', `/repos/${owner}/${repoName}/git/blobs`, {
          content: payload,
          encoding: 'base64',
        });
      } else {
        // URL-encoded (e.g. some SVGs) — decode and send as utf-8
        const decoded = decodeURIComponent(payload);
        blob = await ghApi(studentKey, 'POST', `/repos/${owner}/${repoName}/git/blobs`, {
          content: Buffer.from(decoded, 'utf-8').toString('base64'),
          encoding: 'base64',
        });
      }
    } else {
      blob = await ghApi(studentKey, 'POST', `/repos/${owner}/${repoName}/git/blobs`, {
        content,
        encoding: 'utf-8',
      });
    }
    blobs[path] = blob.sha;
  }

  // Build tree
  const tree = Object.entries(blobs).map(([path, sha]) => ({
    path,
    mode: '100644',
    type: 'blob',
    sha,
  }));

  const treeBody = baseTreeSha
    ? { base_tree: baseTreeSha, tree }
    : { tree };

  const newTree = await ghApi(studentKey, 'POST', `/repos/${owner}/${repoName}/git/trees`, treeBody);

  // Create commit
  const commitBody = {
    message,
    tree: newTree.sha,
    parents: parentSha ? [parentSha] : [],
  };
  const newCommit = await ghApi(studentKey, 'POST', `/repos/${owner}/${repoName}/git/commits`, commitBody);

  // Update or create branch ref
  if (parentSha) {
    await ghApi(studentKey, 'PATCH', `/repos/${owner}/${repoName}/git/refs/heads/${branch}`, {
      sha: newCommit.sha,
      force: false,
    });
  } else {
    await ghApi(studentKey, 'POST', `/repos/${owner}/${repoName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: newCommit.sha,
    });
  }

  return {
    owner,
    repo: repoName,
    branch,
    commit_sha: newCommit.sha,
    url: `https://github.com/${owner}/${repoName}`,
    files_count: Object.keys(blobs).length,
  };
}
