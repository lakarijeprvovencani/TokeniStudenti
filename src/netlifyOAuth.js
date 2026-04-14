/**
 * Netlify OAuth integration.
 * Lets users connect their Netlify account so VajbAgent can deploy sites
 * with one click — no token paste needed.
 */

import crypto from 'crypto';
import { getRedis } from './redis.js';

const CLIENT_ID = process.env.NETLIFY_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.NETLIFY_OAUTH_CLIENT_SECRET || '';

const AUTHORIZE_URL = 'https://app.netlify.com/authorize';
const TOKEN_URL = 'https://api.netlify.com/oauth/token';
const API_BASE = 'https://api.netlify.com/api/v1';

const REDIRECT_URI = process.env.NETLIFY_OAUTH_REDIRECT_URI || 'https://vajbagent.com/auth/netlify/callback';

const stateStore = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of stateStore) {
    if (data.expires < now) stateStore.delete(token);
  }
}, 60_000).unref?.();

export function isNetlifyOAuthConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ─── Token storage ───────────────────────────────────────────────────────────

async function saveToken(studentKey, tokenData) {
  const redis = getRedis();
  if (!redis) return;
  const key = `vajb:netlify:tokens:${studentKey}`;
  await redis.set(key, JSON.stringify(tokenData));
}

async function loadToken(studentKey) {
  const redis = getRedis();
  if (!redis) return null;
  const key = `vajb:netlify:tokens:${studentKey}`;
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
  const key = `vajb:netlify:tokens:${studentKey}`;
  await redis.del(key);
}

// ─── OAuth flow ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(studentKey) {
  if (!isNetlifyOAuthConfigured()) {
    throw new Error('Netlify OAuth not configured');
  }
  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { studentKey, expires: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function handleCallback(code, state, expectedStudentKey) {
  if (!code || !state) throw new Error('Missing code or state');

  const stateData = stateStore.get(state);
  if (!stateData) throw new Error('Invalid or expired state');
  stateStore.delete(state);
  if (stateData.expires < Date.now()) throw new Error('State expired');

  // Anti-CSRF: the callback MUST come from the same session that started the flow.
  if (expectedStudentKey && stateData.studentKey !== expectedStudentKey) {
    throw new Error('Session mismatch — initiator and callback are different users');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Netlify token exchange failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in Netlify response');

  // Fetch user info
  const userResp = await fetch(`${API_BASE}/user`, {
    headers: { 'Authorization': `Bearer ${data.access_token}` },
  });
  const user = userResp.ok ? await userResp.json() : {};

  await saveToken(stateData.studentKey, {
    access_token: data.access_token,
    user_id: user.id || null,
    email: user.email || null,
    full_name: user.full_name || null,
  });

  return { studentKey: stateData.studentKey, email: user.email };
}

export async function isConnected(studentKey) {
  const t = await loadToken(studentKey);
  return !!t;
}

export async function getConnectionInfo(studentKey) {
  const t = await loadToken(studentKey);
  if (!t) return null;
  return {
    email: t.email,
    full_name: t.full_name,
  };
}

export async function disconnect(studentKey) {
  await deleteToken(studentKey);
}

// ─── Netlify API helpers ─────────────────────────────────────────────────────

async function netlifyApi(studentKey, method, path, body, headers = {}) {
  const t = await loadToken(studentKey);
  if (!t) throw new Error('Not connected to Netlify');

  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${t.access_token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Netlify API ${method} ${path} failed: ${resp.status} ${errText.substring(0, 300)}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

/** List user's sites */
export async function listSites(studentKey) {
  return netlifyApi(studentKey, 'GET', '/sites');
}

/** Create a new site */
export async function createSite(studentKey, name) {
  const body = name ? { name } : {};
  return netlifyApi(studentKey, 'POST', '/sites', body);
}

/**
 * Deploy files to a site (creates new site if siteId not given).
 * Uses Netlify's file digest deploy API.
 */
export async function deploySite(studentKey, { files, siteId, siteName }) {
  if (!files || Object.keys(files).length === 0) {
    throw new Error('No files to deploy');
  }

  // Create site if not specified
  let targetSiteId = siteId;
  let siteUrl = '';
  if (!targetSiteId) {
    const newSite = await createSite(studentKey, siteName);
    targetSiteId = newSite.id;
    siteUrl = newSite.ssl_url || newSite.url;
  } else {
    const site = await netlifyApi(studentKey, 'GET', `/sites/${targetSiteId}`);
    siteUrl = site.ssl_url || site.url;
  }

  // Compute SHA1 of each file and build digest.
  // fileContents stores either a string (text files) or a Buffer (user
  // uploaded binary assets decoded from data URLs) — netlify's PUT endpoint
  // accepts both and the digest must match the raw bytes that will be sent.
  const fileShas = {};
  const fileContents = {};
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    if (/^(node_modules|\.git|\.next|\.nuxt|\.cache|\.turbo|\.idea|\.vscode|coverage)\//.test(path)) continue;
    const base = path.split('/').pop() || path;
    // Never deploy environment files or credential files — defense-in-depth
    if (/^\.env(\..*)?$/.test(base)) continue;
    if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(base)) continue;
    if (/^(service-account|firebase-credentials|credentials|secrets)(\..+)?\.json$/i.test(base)) continue;
    if (/^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/.test(base)) continue;
    if (typeof content !== 'string') continue;

    // Data URL → Buffer of real bytes for binary assets.
    let payload;
    if (content.startsWith('data:')) {
      const commaIdx = content.indexOf(',');
      const header = commaIdx >= 0 ? content.slice(5, commaIdx) : '';
      const isBase64 = header.includes(';base64');
      const encoded = commaIdx >= 0 ? content.slice(commaIdx + 1) : '';
      payload = isBase64
        ? Buffer.from(encoded, 'base64')
        : Buffer.from(decodeURIComponent(encoded), 'utf-8');
    } else {
      payload = content;
    }

    const sha = crypto.createHash('sha1').update(payload).digest('hex');
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    fileShas[normalizedPath] = sha;
    fileContents[normalizedPath] = payload;
  }

  // POST deploy with file digest
  const deploy = await netlifyApi(studentKey, 'POST', `/sites/${targetSiteId}/deploys`, {
    files: fileShas,
    async: false,
    draft: false,
  });

  // Upload required files
  const required = deploy.required || [];
  for (const sha of required) {
    const path = Object.keys(fileShas).find(p => fileShas[p] === sha);
    if (!path) continue;
    const content = fileContents[path];

    const t = await loadToken(studentKey);
    const uploadResp = await fetch(`${API_BASE}/deploys/${deploy.id}/files${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${t.access_token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '');
      throw new Error(`File upload failed for ${path}: ${uploadResp.status} ${errText.substring(0, 200)}`);
    }
  }

  return {
    site_id: targetSiteId,
    deploy_id: deploy.id,
    url: siteUrl,
    deploy_url: deploy.deploy_ssl_url || deploy.deploy_url,
    state: deploy.state,
  };
}
