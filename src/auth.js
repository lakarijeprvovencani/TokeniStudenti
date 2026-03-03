/**
 * Valid student API keys from env (comma-separated).
 * In production you might use a DB or external service.
 */
function getValidKeys() {
  const raw = process.env.STUDENT_API_KEYS || '';
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
}

/**
 * Returns a short identifier for logging (e.g. last 8 chars of key).
 */
export function keyId(key) {
  if (!key || key.length < 8) return 'unknown';
  return key.slice(-8);
}

/**
 * Express middleware: require Authorization: Bearer <student-api-key>.
 * Sets req.studentApiKey and req.studentKeyId for downstream use.
 */
export function requireStudentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Missing or invalid Authorization header. Use Bearer <your-api-key>.' },
    });
  }
  const token = auth.slice(7).trim();
  const validKeys = getValidKeys();
  if (!validKeys.length) {
    console.warn('No STUDENT_API_KEYS configured; rejecting all requests.');
    return res.status(503).json({
      error: { message: 'Server not configured with valid API keys.' },
    });
  }
  if (!validKeys.includes(token)) {
    return res.status(403).json({
      error: { message: 'Invalid API key.' },
    });
  }
  req.studentApiKey = token;
  req.studentKeyId = keyId(token);
  next();
}
