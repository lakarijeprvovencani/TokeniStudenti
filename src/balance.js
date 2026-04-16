import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRedis, isRedisConfigured } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.json');
const REDIS_KEY = 'vajb:balances';
const REDIS_DEPOSITS_KEY = 'vajb:deposits';

function ensureDataDir() {
  const dir = path.dirname(BALANCES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let balanceCache = null;
let cacheTime = 0;
const CACHE_TTL = 2000;

// ---- File-based fallback ----
function readBalancesFile() {
  ensureDataDir();
  if (!fs.existsSync(BALANCES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeBalancesFile(balances) {
  ensureDataDir();
  fs.writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2), 'utf8');
}

// ---- Redis + cache layer ----
async function readBalances() {
  if (balanceCache && (Date.now() - cacheTime < CACHE_TTL)) return balanceCache;
  const r = getRedis();
  if (r) {
    try {
      let data = await r.get(REDIS_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        balanceCache = data;
        cacheTime = Date.now();
        return balanceCache;
      }
    } catch (err) {
      console.error('Redis read balances error:', err.message);
    }
  }
  const fb = readBalancesFile();
  balanceCache = fb;
  cacheTime = Date.now();
  return fb;
}

async function writeBalances(balances) {
  const r = getRedis();
  if (r) {
    try {
      await r.set(REDIS_KEY, balances);
    } catch (err) {
      console.error('Redis write balances error:', err.message);
    }
  }
  balanceCache = { ...balances };
  cacheTime = Date.now();
  try { writeBalancesFile(balances); } catch {}
}

export async function getBalance(keyId) {
  const b = await readBalances();
  const v = b[keyId];
  return typeof v === 'number' ? v : 0;
}

// In-process lock (sufficient when running a single worker) and a Redis-backed
// lock (required when scaled horizontally). With file/JSON storage both
// readers hit the same blob, so a distributed lock is the only way to avoid
// classic read-modify-write lost updates.
const balanceLocks = new Map();

async function acquireRedisLock(keyId, ttlMs = 5000) {
  const r = getRedis();
  if (!r) return null;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockKey = `vajb:lock:balance:${keyId}`;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      // Upstash client: options object — { nx: true, px: ms }
      const ok = await r.set(lockKey, token, { nx: true, px: ttlMs });
      if (ok) return { lockKey, token };
    } catch {
      return null;
    }
    await new Promise(res => setTimeout(res, 25 + Math.random() * 50));
  }
  return null;
}

async function releaseRedisLock(lock) {
  if (!lock) return;
  const r = getRedis();
  if (!r) return;
  try {
    // Best-effort: only delete if we still own it.
    const current = await r.get(lock.lockKey);
    if (current === lock.token) await r.del(lock.lockKey);
  } catch { /* ignore */ }
}

async function withBalanceLock(keyId, fn) {
  while (balanceLocks.has(keyId)) await balanceLocks.get(keyId);
  let resolve;
  const p = new Promise(r => { resolve = r; });
  balanceLocks.set(keyId, p);
  const redisLock = await acquireRedisLock(keyId);
  try {
    // Force a fresh read while holding the lock
    balanceCache = null;
    return await fn();
  } finally {
    await releaseRedisLock(redisLock);
    balanceLocks.delete(keyId);
    resolve();
  }
}

export async function addBalance(keyId, amountUsd) {
  return withBalanceLock(keyId, async () => {
    const b = await readBalances();
    const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
    const next = Math.round((current + amountUsd) * 100) / 100;
    b[keyId] = next;
    await writeBalances(b);
    if (amountUsd > 0) await trackDeposit(keyId, amountUsd);
    return next;
  });
}

export async function deductBalance(keyId, amountUsd) {
  return withBalanceLock(keyId, async () => {
    const b = await readBalances();
    const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
    // Floor at zero — even tiny negative balances compound into real money
    // loss across thousands of streamed requests. If callers want to be
    // warned about overdrafts they should compare `current` before calling.
    const raw = current - amountUsd;
    const next = Math.round(Math.max(0, raw) * 100) / 100;
    b[keyId] = next;
    await writeBalances(b);
    return next;
  });
}

// ---- Deposits tracking (total ever deposited per user) ----
function readDepositsFile() {
  ensureDataDir();
  if (!fs.existsSync(DEPOSITS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DEPOSITS_FILE, 'utf8')); } catch { return {}; }
}
function writeDepositsFile(d) {
  ensureDataDir();
  fs.writeFileSync(DEPOSITS_FILE, JSON.stringify(d, null, 2), 'utf8');
}

let depositsCache = null;
let depositsCacheTime = 0;

async function readDeposits() {
  if (depositsCache && (Date.now() - depositsCacheTime < CACHE_TTL)) return depositsCache;
  const r = getRedis();
  if (r) {
    try {
      let data = await r.get(REDIS_DEPOSITS_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        depositsCache = data;
        depositsCacheTime = Date.now();
        return depositsCache;
      }
    } catch {}
  }
  const fb = readDepositsFile();
  depositsCache = fb;
  depositsCacheTime = Date.now();
  return fb;
}

async function writeDeposits(deposits) {
  const r = getRedis();
  if (r) { try { await r.set(REDIS_DEPOSITS_KEY, deposits); } catch {} }
  depositsCache = { ...deposits };
  depositsCacheTime = Date.now();
  try { writeDepositsFile(deposits); } catch {}
}

async function trackDeposit(keyId, amount) {
  const d = await readDeposits();
  d[keyId] = (d[keyId] || 0) + amount;
  await writeDeposits(d);
}

export async function getTotalDeposited(keyId) {
  const d = await readDeposits();
  return d[keyId] || 0;
}

/**
 * All model prices: USD per million tokens (input, output).
 */
const PRICES = {
  // OpenAI GPT-5 series
  'gpt-5-mini': { in: 0.25, out: 2.00 },
  'o4-mini':    { in: 1.10, out: 4.40 },
  'gpt-5':      { in: 1.25, out: 10.00 },
  'gpt-5.4':    { in: 2.50, out: 15.00 },
  // Claude models
  'claude-sonnet-4-6': { in: 3.00, out: 15.0 },
  'claude-opus-4-6':   { in: 5.00, out: 25.0 },
  // Legacy (for historical cost calculations)
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'gpt-4.1':      { in: 2.00, out: 8.00 },
  'gpt-4o-mini':  { in: 0.15, out: 0.60 },
  'gpt-4o':       { in: 2.50, out: 10.0 },
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
};

const DEFAULT_PRICE = { in: 3, out: 15 };

/** Public copy for admin UI (single source of truth with providerCostUsd). */
export function getPrices() {
  return { ...PRICES };
}

function getPrice(model) {
  if (model && PRICES[model]) return PRICES[model];
  const m = (model || '').toLowerCase();
  if (m.includes('5-mini'))   return PRICES['gpt-5-mini'];
  if (m.includes('5.4'))      return PRICES['gpt-5.4'];
  if (m.includes('gpt-5'))    return PRICES['gpt-5'];
  if (m.includes('o4-mini'))  return PRICES['o4-mini'];
  if (m.includes('opus'))     return PRICES['claude-opus-4-6'];
  if (m.includes('sonnet'))   return PRICES['claude-sonnet-4-6'];
  if (m.includes('haiku'))    return PRICES['claude-haiku-4-5'];
  if (m.includes('4.1-mini')) return PRICES['gpt-4.1-mini'];
  if (m.includes('gpt-4.1'))  return PRICES['gpt-4.1'];
  if (m.includes('4o-mini'))  return PRICES['gpt-4o-mini'];
  if (m.includes('gpt-4o'))   return PRICES['gpt-4o'];
  return DEFAULT_PRICE;
}

export function providerCostUsd(inputTokens, outputTokens, model) {
  const price = getPrice(model);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

/**
 * Cost calculation with prompt caching discounts.
 *   - uncachedInput: regular input tokens (fresh) → 100% of input price
 *   - cacheReadInput: cache hit tokens            → 10% of input price
 *   - cacheCreationInput: cache write (first)     → 125% of input price (Anthropic)
 *                                                   100% for OpenAI (no write premium)
 *
 * Anthropic charges a 1.25x premium on cache writes; OpenAI does not.
 * Both charge ~10% on cache reads.
 */
export function providerCostUsdWithCache(opts, model) {
  const price = getPrice(model);
  const uncached = Math.max(0, Number(opts.uncachedInput) || 0);
  const cacheRead = Math.max(0, Number(opts.cacheReadInput) || 0);
  const cacheCreate = Math.max(0, Number(opts.cacheCreationInput) || 0);
  const output = Math.max(0, Number(opts.outputTokens) || 0);
  const isAnthropic = /claude|opus|sonnet|haiku/i.test(model || '');
  const createMultiplier = isAnthropic ? 1.25 : 1.0;

  return (
    (uncached / 1e6) * price.in +
    (cacheRead / 1e6) * price.in * 0.10 +
    (cacheCreate / 1e6) * price.in * createMultiplier +
    (output / 1e6) * price.out
  );
}

export const anthropicCostUsd = providerCostUsd;

export function getStudentMarkup(model) {
  // 1. Per-model markup (e.g. MARKUP_GPT_5_MINI=1.50, MARKUP_CLAUDE_OPUS_4_6=1.35)
  if (model) {
    const envKey = 'MARKUP_' + model.toUpperCase().replace(/[\.\-]/g, '_');
    const perModel = parseFloat(process.env[envKey]);
    if (Number.isFinite(perModel) && perModel >= 1) return perModel;
  }
  // 2. Per-provider markup (OPENAI_MARKUP / ANTHROPIC_MARKUP)
  if (model && (model.includes('claude') || model.includes('anthropic'))) {
    const a = parseFloat(process.env.ANTHROPIC_MARKUP);
    if (Number.isFinite(a) && a >= 1) return a;
  } else if (model) {
    const o = parseFloat(process.env.OPENAI_MARKUP);
    if (Number.isFinite(o) && o >= 1) return o;
  }
  // 3. Global fallback
  const v = parseFloat(process.env.STUDENT_MARKUP);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

// Student-specific markup check (for friends/self with no markup)
let studentMarkupCache = new Map();

export function setStudentNoMarkup(keyId, noMarkup) {
  studentMarkupCache.set(keyId, noMarkup);
}

export function getStudentNoMarkup(keyId) {
  return studentMarkupCache.get(keyId) || false;
}

export function loadStudentMarkupFlags(students) {
  studentMarkupCache.clear();
  for (const s of students) {
    if (s.noMarkup) {
      studentMarkupCache.set(s.key, true);
    }
  }
}

export function costUsd(inputTokens, outputTokens, model, keyId = null) {
  const raw = providerCostUsd(inputTokens, outputTokens, model);
  if (keyId && getStudentNoMarkup(keyId)) {
    return Math.round(raw * 1e6) / 1e6;
  }
  return Math.round(raw * getStudentMarkup(model) * 1e6) / 1e6;
}

/** Cost with cache split — same markup logic as costUsd, but honors cache pricing. */
export function costUsdWithCache(opts, model, keyId = null) {
  const raw = providerCostUsdWithCache(opts, model);
  if (keyId && getStudentNoMarkup(keyId)) {
    return Math.round(raw * 1e6) / 1e6;
  }
  return Math.round(raw * getStudentMarkup(model) * 1e6) / 1e6;
}
