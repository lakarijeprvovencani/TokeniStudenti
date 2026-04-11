/**
 * Backend Auth Tests
 * Tests both Bearer (extension) and Cookie (web app) authentication
 * Run: node test-auth.mjs
 */

const BASE = 'http://localhost:3000'
let passed = 0
let failed = 0
const results = []

function log(name, ok, detail = '') {
  if (ok) {
    passed++
    results.push(`  ✅ ${name}`)
  } else {
    failed++
    results.push(`  ❌ ${name} — ${detail}`)
  }
}

async function fetchJSON(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    ...rest,
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, headers: res.headers }
}

// ─── 1. BEARER AUTH (Extension compatibility) ────────────────────────────────

async function testBearerAuth() {
  console.log('\n📋 BEARER AUTH (Cursor extension)')

  // Valid key
  const r1 = await fetchJSON('/me', { headers: { Authorization: 'Bearer student-key-1' } })
  log('GET /me with valid Bearer → 200', r1.status === 200)
  log('GET /me returns name', r1.body.name === 'Student 1', `got: ${r1.body.name}`)
  log('GET /me returns balance', typeof r1.body.balance_usd === 'number', `got: ${r1.body.balance_usd}`)
  log('GET /me does NOT return api_key for Bearer', !r1.body.api_key, `got: ${r1.body.api_key}`)

  // Invalid key
  const r2 = await fetchJSON('/me', { headers: { Authorization: 'Bearer invalid-key-123' } })
  log('GET /me with invalid Bearer → 403', r2.status === 403)

  // No auth
  const r3 = await fetchJSON('/me')
  log('GET /me without auth → 401', r3.status === 401)

  // Chat completions with Bearer
  const r4 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer student-key-1',
    },
    body: JSON.stringify({
      model: 'vajb-agent-lite',
      messages: [{ role: 'user', content: 'Say "test123" and nothing else' }],
      max_tokens: 10,
      stream: false,
    }),
  })
  log('POST /v1/chat/completions with Bearer → 200', r4.status === 200, `got: ${r4.status}`)

  // Chat completions without auth
  const r5 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'vajb-agent-lite',
      messages: [{ role: 'user', content: 'test' }],
    }),
  })
  log('POST /v1/chat/completions without auth → 401', r5.status === 401)
}

// ─── 2. COOKIE AUTH (Web app) ────────────────────────────────────────────────

async function testCookieAuth() {
  console.log('\n📋 COOKIE AUTH (Web app)')

  // Register new user
  const regEmail = `test-${Date.now()}@example.com`
  const r1 = await fetchJSON('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Test',
      last_name: 'User',
      email: regEmail,
      password: 'test123456',
    }),
  })
  log('POST /auth/register → 200', r1.status === 200, `got: ${r1.status} ${JSON.stringify(r1.body)}`)
  log('Register returns name', r1.body.name === 'Test User', `got: ${r1.body.name}`)
  log('Register returns balance', typeof r1.body.balance_usd === 'number', `got: ${r1.body.balance_usd}`)
  log('Register returns free_tier', r1.body.free_tier === true, `got: ${r1.body.free_tier}`)

  // Extract session cookie
  const setCookie = r1.headers.get('set-cookie') || ''
  const cookieMatch = setCookie.match(/vajb_session=([^;]+)/)
  const sessionCookie = cookieMatch ? cookieMatch[1] : ''
  log('Register returns session cookie', !!sessionCookie, `got: ${setCookie.substring(0, 50)}`)

  if (!sessionCookie) {
    log('SKIP remaining cookie tests — no cookie received', false)
    return
  }

  // /auth/me with cookie
  const r2 = await fetchJSON('/auth/me', {
    headers: { Cookie: `vajb_session=${sessionCookie}` },
  })
  log('GET /auth/me with cookie → 200', r2.status === 200, `got: ${r2.status}`)
  log('/auth/me returns api_key for cookie auth', !!r2.body.api_key, `got: ${r2.body.api_key?.substring(0, 12)}`)

  // /me with cookie (same endpoint extension uses)
  const r3 = await fetchJSON('/me', {
    headers: { Cookie: `vajb_session=${sessionCookie}` },
  })
  log('GET /me with cookie → 200', r3.status === 200, `got: ${r3.status}`)
  log('/me returns name', r3.body.name === 'Test User', `got: ${r3.body.name}`)

  // Login with password
  const r4 = await fetchJSON('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: regEmail, password: 'test123456' }),
  })
  log('POST /auth/login → 200', r4.status === 200, `got: ${r4.status} ${JSON.stringify(r4.body)}`)
  log('Login returns free_tier', typeof r4.body.free_tier === 'boolean', `got: ${r4.body.free_tier}`)

  const loginCookie = (r4.headers.get('set-cookie') || '').match(/vajb_session=([^;]+)/)?.[1] || ''
  log('Login returns session cookie', !!loginCookie)

  // Wrong password
  const r5 = await fetchJSON('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: regEmail, password: 'wrongpass' }),
  })
  log('POST /auth/login wrong password → 401', r5.status === 401)

  // Duplicate registration
  const r6 = await fetchJSON('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Test',
      last_name: 'User',
      email: regEmail,
      password: 'test123456',
    }),
  })
  log('POST /auth/register duplicate email → 400', r6.status === 400)

  // Logout
  const r7 = await fetchJSON('/auth/logout', {
    method: 'POST',
    headers: { Cookie: `vajb_session=${sessionCookie}` },
  })
  log('POST /auth/logout → 200', r7.status === 200)

  // After logout, cookie should be invalid
  const r8 = await fetchJSON('/me', {
    headers: { Cookie: `vajb_session=${sessionCookie}` },
  })
  log('GET /me after logout → 401', r8.status === 401, `got: ${r8.status}`)
}

// ─── 3. MIXED AUTH (Bearer + Cookie coexistence) ─────────────────────────────

async function testMixedAuth() {
  console.log('\n📋 MIXED AUTH (Bearer and Cookie coexist)')

  // Bearer should always work regardless of cookies
  const r1 = await fetchJSON('/me', {
    headers: {
      Authorization: 'Bearer student-key-1',
      Cookie: 'vajb_session=invalid-session-token',
    },
  })
  log('Bearer takes priority over invalid cookie', r1.status === 200, `got: ${r1.status}`)
  log('Returns correct user for Bearer', r1.body.name === 'Student 1', `got: ${r1.body.name}`)
}

// ─── 4. SET PASSWORD (Existing users migrating to web) ───────────────────────

async function testSetPassword() {
  console.log('\n📋 SET PASSWORD (Extension → Web migration)')

  // First register a user (simulating existing student)
  const email = `migrate-${Date.now()}@example.com`
  const r0 = await fetchJSON('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Migrate',
      last_name: 'Test',
      email,
      password: 'oldpass123',
    }),
  })
  if (r0.status !== 200) {
    log('Setup: create test user', false, `${r0.status}`)
    return
  }

  // Get the API key from /auth/me
  const cookie = (r0.headers.get('set-cookie') || '').match(/vajb_session=([^;]+)/)?.[1] || ''
  const me = await fetchJSON('/auth/me', { headers: { Cookie: `vajb_session=${cookie}` } })
  const apiKey = me.body.api_key

  // Set new password using API key
  const r1 = await fetchJSON('/auth/set-password', {
    method: 'POST',
    body: JSON.stringify({
      email,
      current_key: apiKey,
      new_password: 'newpass789',
    }),
  })
  log('POST /auth/set-password → 200', r1.status === 200, `got: ${r1.status} ${JSON.stringify(r1.body)}`)

  // Login with new password
  const r2 = await fetchJSON('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'newpass789' }),
  })
  log('Login with new password works', r2.status === 200, `got: ${r2.status}`)

  // Old password should fail
  const r3 = await fetchJSON('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'oldpass123' }),
  })
  log('Old password fails after set-password', r3.status === 401, `got: ${r3.status}`)

  // Wrong API key
  const r4 = await fetchJSON('/auth/set-password', {
    method: 'POST',
    body: JSON.stringify({
      email,
      current_key: 'va-fake-key-12345678',
      new_password: 'hack123',
    }),
  })
  log('Set-password with wrong API key → 401', r4.status === 401, `got: ${r4.status}`)
}

// ─── 5. CORS CHECK ───────────────────────────────────────────────────────────

async function testCORS() {
  console.log('\n📋 CORS')

  const r1 = await fetch(`${BASE}/me`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  const allowOrigin = r1.headers.get('access-control-allow-origin')
  const allowCreds = r1.headers.get('access-control-allow-credentials')
  log('CORS allows origin', !!allowOrigin, `got: ${allowOrigin}`)
  log('CORS allows credentials', allowCreds === 'true', `got: ${allowCreds}`)
}

// ─── RUN ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════')
  console.log('  VajbAgent Backend Auth Tests')
  console.log('═══════════════════════════════════════════')

  try {
    await testBearerAuth()
    await testCookieAuth()
    await testMixedAuth()
    await testSetPassword()
    await testCORS()
  } catch (err) {
    console.error('\n💥 Test crash:', err.message)
  }

  console.log('\n═══════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('═══════════════════════════════════════════')
  for (const r of results) console.log(r)
  console.log('')

  if (failed > 0) {
    console.log('⚠️  FIX FAILURES BEFORE DEPLOYING BACKEND')
    process.exit(1)
  } else {
    console.log('✅ All tests passed — safe to deploy backend')
    process.exit(0)
  }
}

run()
