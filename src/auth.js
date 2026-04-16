import crypto from 'crypto';
import { getActiveKeys, findByKey } from './students.js';
import { getRedis } from './redis.js';

export function keyId(key) {
  if (!key) return 'unknown';
  return key.trim();
}

/**
 * Non-reversible public identifier for a student. Derived from the raw key so
 * it's stable across sessions, but on its own can't be used as an API key.
 * Safe to ship to the browser / localStorage / logs.
 */
export function publicUserId(key) {
  if (!key) return 'anon';
  const h = crypto.createHash('sha256').update(String(key).trim()).digest('hex');
  return 'u_' + h.slice(0, 24);
}

// Short identifier for logging — never expose full key in logs.
export function keyIdShort(key) {
  if (!key) return 'unknown';
  const t = key.trim();
  if (t.length <= 10) return t.slice(0, 4) + '***';
  return t.slice(0, 6) + '...' + t.slice(-3);
}

function safeMatch(candidate, list) {
  const candidateHash = crypto.createHash('sha256').update(String(candidate)).digest();
  let matched = null;
  for (const valid of list) {
    const validHash = crypto.createHash('sha256').update(String(valid)).digest();
    if (crypto.timingSafeEqual(candidateHash, validHash)) {
      matched = valid;
    }
  }
  return matched;
}

// ─── Session management ─────────────────────────────────────────────────────
// Sessions are persisted in Redis when available, so they survive server restarts
// and work across multiple instances. When Redis isn't configured, falls back to
// an in-memory Map (dev/test only). Both backends expose the same API, so the
// rest of the codebase doesn't care which one is active.
//
// NOTE: ALL exported session functions are async. Callers must `await` them.

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_TTL_SEC = SESSION_TTL_MS / 1000;
const SESSION_PREFIX = 'vajb:session:';
const SESSION_KEY_INDEX_PREFIX = 'vajb:session_key_index:'; // studentKey → Set<token>

// In-memory fallback
const memorySessions = new Map(); // token → { studentKey, expires }

export async function createSession(studentKey) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  const session = { studentKey, expires };

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(SESSION_PREFIX + token, JSON.stringify(session), { ex: SESSION_TTL_SEC });
      // Also record token in a per-user set so we can bulk-invalidate on password change
      await redis.sadd(SESSION_KEY_INDEX_PREFIX + studentKey, token);
      // Keep the index alive as long as any individual session could be alive
      await redis.expire(SESSION_KEY_INDEX_PREFIX + studentKey, SESSION_TTL_SEC + 3600);
    } catch (err) {
      console.warn('[session] Redis createSession failed, falling back to memory:', err.message);
      memorySessions.set(token, session);
    }
  } else {
    memorySessions.set(token, session);
  }
  return { token, expires };
}

export async function validateSession(token) {
  if (!token) return null;

  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(SESSION_PREFIX + token);
      if (!raw) return null;
      const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!session || Date.now() > session.expires) {
        try { await redis.del(SESSION_PREFIX + token); } catch {}
        return null;
      }
      return session;
    } catch (err) {
      console.warn('[session] Redis validateSession failed:', err.message);
      // Fall through to memory
    }
  }

  // Memory fallback
  const session = memorySessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) {
    memorySessions.delete(token);
    return null;
  }
  return session;
}

export async function destroySession(token) {
  if (!token) return;
  const redis = getRedis();
  if (redis) {
    try {
      // Look up studentKey first so we can scrub the index set
      const raw = await redis.get(SESSION_PREFIX + token);
      const session = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      await redis.del(SESSION_PREFIX + token);
      if (session?.studentKey) {
        try { await redis.srem(SESSION_KEY_INDEX_PREFIX + session.studentKey, token); } catch {}
      }
    } catch (err) {
      console.warn('[session] Redis destroySession failed:', err.message);
    }
  }
  memorySessions.delete(token);
}

/**
 * Invalidate ALL active sessions for a given student key.
 * Called on password change / account lockout so old sessions can't survive a credential reset.
 */
export async function destroyAllSessionsForKey(studentKey) {
  if (!studentKey) return 0;
  let count = 0;

  const redis = getRedis();
  if (redis) {
    try {
      const tokens = await redis.smembers(SESSION_KEY_INDEX_PREFIX + studentKey);
      if (Array.isArray(tokens) && tokens.length > 0) {
        for (const t of tokens) {
          try { await redis.del(SESSION_PREFIX + t); count++; } catch {}
        }
        try { await redis.del(SESSION_KEY_INDEX_PREFIX + studentKey); } catch {}
      }
    } catch (err) {
      console.warn('[session] Redis destroyAllSessionsForKey failed:', err.message);
    }
  }

  // Also clean memory fallback
  for (const [token, session] of memorySessions.entries()) {
    if (session.studentKey === studentKey) {
      memorySessions.delete(token);
      count++;
    }
  }
  return count;
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(c => {
    const [name, ...rest] = c.split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

// ─── Cookie helper ──────────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';

export function setSessionCookie(res, token) {
  res.cookie('vajb_session', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.cookie('vajb_session', '', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 0,
    path: '/',
  });
}

// ─── Auth middleware: API key only (for extension) ──────────────────────────

export async function requireStudentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Missing or invalid Authorization header. Use Bearer <your-api-key>.' },
    });
  }
  const token = auth.slice(7).trim();
  if (!token || token.length < 5) {
    return res.status(401).json({
      error: { message: 'API ključ je prekratak.' },
    });
  }
  try {
    const validKeys = await getActiveKeys();
    if (!validKeys.length) {
      console.warn('No active students configured.');
      return res.status(503).json({
        error: { message: 'Server nema konfigurisanih studenata. Kontaktiraj administratora.' },
      });
    }
    const matched = safeMatch(token, validKeys);
    if (!matched) {
      return res.status(403).json({
        error: { message: 'Nevažeći API ključ.' },
      });
    }
    const student = await findByKey(matched);
    req.studentApiKey = matched;
    req.studentKeyId = keyId(matched);
    req.studentName = student?.name || 'Unknown';
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(500).json({ error: { message: 'Greška pri autentifikaciji.' } });
  }
}

// ─── Combined auth: API key OR session cookie (for web + extension) ─────────

export async function requireAuth(req, res, next) {
  // 1. Try Bearer token (extension)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return requireStudentAuth(req, res, next);
  }

  // 2. Try session cookie (web app)
  const cookies = parseCookies(req);
  const sessionToken = cookies.vajb_session;
  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session) {
      const student = await findByKey(session.studentKey);
      if (student && student.active) {
        req.studentApiKey = student.key;
        req.studentKeyId = keyId(student.key);
        req.studentName = student.name;
        return next();
      }
    }
  }

  return res.status(401).json({
    error: { message: 'Autentifikacija je potrebna. Uloguj se ili koristi API ključ.' },
  });
}
