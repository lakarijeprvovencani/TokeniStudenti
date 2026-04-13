/**
 * Supabase OAuth integration.
 * Lets users connect their Supabase account via OAuth so VajbAgent can
 * automatically create projects, manage databases, and inject credentials.
 */

import crypto from 'crypto';
import { getRedis } from './redis.js';

const CLIENT_ID = process.env.SUPABASE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SUPABASE_OAUTH_CLIENT_SECRET || '';

const AUTHORIZE_URL = 'https://api.supabase.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';
const API_BASE = 'https://api.supabase.com/v1';

const REDIRECT_URI = (process.env.SUPABASE_OAUTH_REDIRECT_URI || 'https://vajbagent.com/auth/supabase/callback');

const SCOPES = [
  'projects:read',
  'projects:write',
  'organizations:read',
  'database:read',
  'database:write',
  'rest:read',
  'rest:write',
  'auth:read',
  'auth:write',
  'secrets:read',
  'secrets:write',
  'edge-functions:read',
  'edge-functions:write',
  'storage:read',
  'storage:write',
].join(' ');

// In-memory state store: state token → { studentKey, codeVerifier, expires }
// Used during the OAuth dance (5 min TTL)
const stateStore = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of stateStore) {
    if (data.expires < now) stateStore.delete(token);
  }
}, 60_000).unref?.();

export function isSupabaseOAuthConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ─── PKCE helpers ───────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Token storage in Upstash Redis ─────────────────────────────────────────
// Key format: `vajb:supabase:tokens:${studentKey}`
// Value: { access_token, refresh_token, expires_at, scope }

async function saveTokens(studentKey, tokens) {
  const redis = getRedis();
  if (!redis) {
    console.warn('[SupabaseOAuth] Redis not configured, tokens not persisted');
    return;
  }
  const key = `vajb:supabase:tokens:${studentKey}`;
  await redis.set(key, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    scope: tokens.scope || '',
  }));
}

async function loadTokens(studentKey) {
  const redis = getRedis();
  if (!redis) return null;
  const key = `vajb:supabase:tokens:${studentKey}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw; // Upstash auto-parses JSON sometimes
}

async function deleteTokens(studentKey) {
  const redis = getRedis();
  if (!redis) return;
  const key = `vajb:supabase:tokens:${studentKey}`;
  await redis.del(key);
}

// ─── OAuth flow ─────────────────────────────────────────────────────────────

/**
 * Start the OAuth flow. Returns the URL to redirect the user to.
 */
export function buildAuthorizeUrl(studentKey) {
  if (!isSupabaseOAuthConfigured()) {
    throw new Error('Supabase OAuth not configured on backend');
  }

  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  stateStore.set(state, {
    studentKey,
    codeVerifier,
    expires: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: SCOPES,
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Handle the OAuth callback. Exchange code for tokens and save them.
 */
export async function handleCallback(code, state) {
  if (!code || !state) {
    throw new Error('Missing code or state');
  }

  const stateData = stateStore.get(state);
  if (!stateData) {
    throw new Error('Invalid or expired state');
  }
  stateStore.delete(state);

  if (stateData.expires < Date.now()) {
    throw new Error('State expired');
  }

  // Exchange code for tokens
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: stateData.codeVerifier,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed: ${resp.status} ${errText}`);
  }

  const tokens = await resp.json();
  // tokens: { access_token, refresh_token, expires_in, token_type, scope }

  const expiresAt = Date.now() + (tokens.expires_in * 1000);
  await saveTokens(stateData.studentKey, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    scope: tokens.scope,
  });

  return { studentKey: stateData.studentKey, expiresAt };
}

/**
 * Get a valid access token for the user, refreshing if needed.
 */
export async function getValidAccessToken(studentKey) {
  const stored = await loadTokens(studentKey);
  if (!stored) return null;

  // Refresh if expires in < 5 min
  if (stored.expires_at - Date.now() < 5 * 60 * 1000 && stored.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(stored.refresh_token);
      const expiresAt = Date.now() + (refreshed.expires_in * 1000);
      await saveTokens(studentKey, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || stored.refresh_token,
        expires_at: expiresAt,
        scope: refreshed.scope || stored.scope,
      });
      return refreshed.access_token;
    } catch (err) {
      console.error('[SupabaseOAuth] Refresh failed:', err.message);
      return null;
    }
  }

  return stored.access_token;
}

async function refreshAccessToken(refreshToken) {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Refresh failed: ${resp.status} ${errText}`);
  }

  return resp.json();
}

export async function isConnected(studentKey) {
  const stored = await loadTokens(studentKey);
  return !!stored;
}

export async function disconnect(studentKey) {
  await deleteTokens(studentKey);
}

// ─── Management API helpers ─────────────────────────────────────────────────

async function apiCall(studentKey, method, path, body) {
  const token = await getValidAccessToken(studentKey);
  if (!token) throw new Error('Not connected to Supabase');

  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Supabase API ${method} ${path} failed: ${resp.status} ${errText}`);
  }

  return resp.json();
}

export async function listOrganizations(studentKey) {
  return apiCall(studentKey, 'GET', '/organizations');
}

/**
 * Run a SQL query against a Supabase project's database.
 * Uses the Management API's /database/query endpoint.
 */
export async function runSql(studentKey, projectRef, query) {
  if (!projectRef) throw new Error('projectRef required');
  if (!query || typeof query !== 'string') throw new Error('query required');
  return apiCall(studentKey, 'POST', `/projects/${projectRef}/database/query`, { query });
}

/**
 * List all tables in the public schema of a Supabase project.
 */
export async function listTables(studentKey, projectRef) {
  const query = `
    SELECT
      table_name,
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND columns.table_name = tables.table_name) as column_count
    FROM information_schema.tables tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;
  return runSql(studentKey, projectRef, query);
}

// ─── Auth Configuration ─────────────────────────────────────────────────────

// ─── Edge Functions ─────────────────────────────────────────────────────────

/** List all edge functions in a project */
export async function listFunctions(studentKey, projectRef) {
  return apiCall(studentKey, 'GET', `/projects/${projectRef}/functions`);
}

/** Get a specific function's body (code) */
export async function getFunctionBody(studentKey, projectRef, slug) {
  const token = await getValidAccessToken(studentKey);
  if (!token) throw new Error('Not connected to Supabase');
  const resp = await fetch(`${API_BASE}/projects/${projectRef}/functions/${slug}/body`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Get function body failed: ${resp.status} ${errText}`);
  }
  return resp.text();
}

/**
 * Deploy (create or update) an edge function.
 * Supabase API: POST/PATCH /projects/{ref}/functions
 */
export async function deployFunction(studentKey, projectRef, { slug, name, body, verify_jwt = true }) {
  if (!slug || !body) throw new Error('slug and body required');

  // Try to update existing first, fall back to create
  const token = await getValidAccessToken(studentKey);
  if (!token) throw new Error('Not connected to Supabase');

  // Check if function exists
  let exists = false;
  try {
    const list = await listFunctions(studentKey, projectRef);
    if (Array.isArray(list)) {
      exists = list.some(f => f.slug === slug);
    }
  } catch { /* ignore */ }

  const url = exists
    ? `${API_BASE}/projects/${projectRef}/functions/${slug}`
    : `${API_BASE}/projects/${projectRef}/functions`;
  const method = exists ? 'PATCH' : 'POST';

  const payload = exists
    ? { body, verify_jwt, name: name || slug }
    : { slug, name: name || slug, body, verify_jwt };

  const resp = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Deploy function failed: ${resp.status} ${errText}`);
  }
  return resp.json();
}

/** Delete an edge function */
export async function deleteFunction(studentKey, projectRef, slug) {
  return apiCall(studentKey, 'DELETE', `/projects/${projectRef}/functions/${slug}`);
}

// ─── Auth Configuration ─────────────────────────────────────────────────────

/** Get auth configuration (site URL, providers, email settings, etc.) */
export async function getAuthConfig(studentKey, projectRef) {
  return apiCall(studentKey, 'GET', `/projects/${projectRef}/config/auth`);
}

/** Update auth configuration. Accepts partial config (PATCH-style merge). */
export async function updateAuthConfig(studentKey, projectRef, config) {
  return apiCall(studentKey, 'PATCH', `/projects/${projectRef}/config/auth`, config);
}

/**
 * Describe a table's columns.
 */
export async function describeTable(studentKey, projectRef, tableName) {
  const safeTable = String(tableName).replace(/[^a-zA-Z0-9_]/g, '');
  const query = `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${safeTable}'
    ORDER BY ordinal_position;
  `;
  return runSql(studentKey, projectRef, query);
}

export async function listProjects(studentKey) {
  return apiCall(studentKey, 'GET', '/projects');
}

/**
 * Create a new Supabase project in the user's organization.
 * Returns: { id, name, ref, region, ... }
 */
export async function createProject(studentKey, { orgId, name, region = 'us-east-1', dbPass }) {
  const password = dbPass || crypto.randomBytes(16).toString('base64url');
  return apiCall(studentKey, 'POST', '/projects', {
    organization_id: orgId,
    name,
    region,
    db_pass: password,
    plan: 'free',
  });
}

/**
 * Get the API keys (anon, service_role) for a project.
 */
export async function getProjectApiKeys(studentKey, projectRef) {
  return apiCall(studentKey, 'GET', `/projects/${projectRef}/api-keys`);
}

/**
 * Get the project URL and anon key — tries multiple endpoints for compatibility.
 */
export async function getProjectCredentials(studentKey, projectRef) {
  const url = `https://${projectRef}.supabase.co`;

  // Try 1: new api-keys endpoint (requires api_gateway_keys:read scope)
  try {
    const keys = await getProjectApiKeys(studentKey, projectRef);
    if (Array.isArray(keys)) {
      const anonKey = keys.find(k => k.name === 'anon' || k.tags?.includes('anon'))?.api_key;
      if (anonKey) return { url, anon_key: anonKey };
    }
  } catch (err) {
    console.warn('[Supabase] api-keys endpoint failed:', err.message);
  }

  // Try 2: legacy project endpoint (returns anon_key in project object)
  try {
    const project = await apiCall(studentKey, 'GET', `/projects/${projectRef}`);
    if (project?.anon_key) return { url, anon_key: project.anon_key };
    if (project?.api?.anon) return { url, anon_key: project.api.anon };
  } catch (err) {
    console.warn('[Supabase] project endpoint failed:', err.message);
  }

  // Try 3: list all projects and find this one
  try {
    const projects = await apiCall(studentKey, 'GET', '/projects');
    const project = projects?.find?.(p => p.ref === projectRef || p.id === projectRef);
    if (project?.anon_key) return { url, anon_key: project.anon_key };
  } catch (err) {
    console.warn('[Supabase] projects list failed:', err.message);
  }

  // All failed — return URL but indicate anon_key is missing
  throw new Error(
    'Nije moguće dobiti anon_key iz Supabase-a preko OAuth-a. ' +
    'Idi na Supabase dashboard → Project Settings → API i kopiraj anon public key ručno u polje ispod.'
  );
}
