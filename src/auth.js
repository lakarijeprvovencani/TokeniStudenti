import { getActiveKeys, findByKey } from './students.js';

/**
 * Returns the key itself as the student identifier.
 */
export function keyId(key) {
  if (!key) return 'unknown';
  return key.trim();
}

/**
 * Express middleware: require Authorization: Bearer <student-api-key>.
 * Sets req.studentApiKey, req.studentKeyId, and req.studentName for downstream use.
 */
export function requireStudentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Missing or invalid Authorization header. Use Bearer <your-api-key>.' },
    });
  }
  const token = auth.slice(7).trim();
  const validKeys = getActiveKeys();
  if (!validKeys.length) {
    console.warn('No active students configured.');
    return res.status(503).json({
      error: { message: 'Server nema konfigurisanih studenata. Kontaktiraj administratora.' },
    });
  }
  if (!validKeys.includes(token)) {
    return res.status(403).json({
      error: { message: 'Nevažeći API ključ.' },
    });
  }
  const student = findByKey(token);
  req.studentApiKey = token;
  req.studentKeyId = keyId(token);
  req.studentName = student?.name || 'Unknown';
  next();
}
