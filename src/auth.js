import crypto from 'crypto';
import { getActiveKeys, findByKey } from './students.js';

export function keyId(key) {
  if (!key) return 'unknown';
  return key.trim();
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

const sessions = new Map(); // token → { studentKey, expires }
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createSession(studentKey) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL;
  sessions.set(token, { studentKey, expires });
  return { token, expires };
}

export function validateSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function destroySession(token) {
  sessions.delete(token);
}

/**
 * Invalidate ALL active sessions for a given student key.
 * Called on password change / account lockout so old sessions can't survive a credential reset.
 */
export function destroyAllSessionsForKey(studentKey) {
  if (!studentKey) return 0;
  let count = 0;
  for (const [token, session] of sessions.entries()) {
    if (session.studentKey === studentKey) {
      sessions.delete(token);
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
    maxAge: SESSION_TTL,
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
    const session = validateSession(sessionToken);
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
