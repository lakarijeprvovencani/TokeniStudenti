/**
 * Valid student API keys from env (comma-separated).
 * In production you might use a DB or external service.
 */
function getValidKeys() {
  const raw = process.env.STUDENT_API_KEYS || '';
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
}

/**
 * Returns the key itself as the identifier (keys are short enough to use directly).
 */
export function keyId(key) {
  if (!key) return 'unknown';
  return key.trim();
}

/**
 * Express middleware: require Authorization: Bearer <student-api-key>.
 * Sets req.studentApiKey and req.studentKeyId for downstream use.
 */
export function requireStudentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    console.log('Auth: 401 – missing or invalid Authorization header');
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
    console.log('Auth: 403 – invalid API key');
    return res.status(403).json({
      error: { message: 'Invalid API key.' },
    });
  }
  req.studentApiKey = token;
  req.studentKeyId = keyId(token);
  next();
}
