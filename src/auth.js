import crypto from 'crypto';
import { getActiveKeys, findByKey } from './students.js';

export function keyId(key) {
  if (!key) return 'unknown';
  return key.trim();
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
