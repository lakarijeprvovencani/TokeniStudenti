import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRedis, isRedisConfigured } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const REDIS_KEY = 'vajb:usage';

function ensureDataDir() {
  const dir = path.dirname(USAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- File fallback ----
function readUsageFile() {
  ensureDataDir();
  if (!fs.existsSync(USAGE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeUsageFile(usage) {
  ensureDataDir();
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
}

// ---- Redis + file layer ----
let usageCache = null;
let usageCacheTime = 0;
const CACHE_TTL = 2000;

async function readUsage() {
  if (usageCache && (Date.now() - usageCacheTime < CACHE_TTL)) return usageCache;
  const r = getRedis();
  if (r) {
    try {
      let data = await r.get(REDIS_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
        usageCache = data;
        usageCacheTime = Date.now();
        return usageCache;
      }
    } catch (err) {
      console.error('Redis read usage error:', err.message);
    }
  }
  const fb = readUsageFile();
  usageCache = fb;
  usageCacheTime = Date.now();
  return fb;
}

async function writeUsage(usage) {
  const r = getRedis();
  if (r) {
    try {
      await r.set(REDIS_KEY, usage);
    } catch (err) {
      console.error('Redis write usage error:', err.message);
    }
  }
  usageCache = { ...usage };
  usageCacheTime = Date.now();
  try { writeUsageFile(usage); } catch {}
}

// Per-process lock + optional Redis lock so concurrent logUsage calls don't
// overwrite each other (two streams for the same key finish simultaneously →
// classic read-modify-write race).
const usageLocks = new Map();

async function acquireUsageRedisLock(ttlMs = 3000) {
  const r = getRedis();
  if (!r) return null;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockKey = 'vajb:lock:usage';
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      const ok = await r.set(lockKey, token, { nx: true, px: ttlMs });
      if (ok) return { lockKey, token };
    } catch {
      return null;
    }
    await new Promise(res => setTimeout(res, 15 + Math.random() * 40));
  }
  return null;
}

async function releaseUsageRedisLock(lock) {
  if (!lock) return;
  const r = getRedis();
  if (!r) return;
  try {
    const current = await r.get(lock.lockKey);
    if (current === lock.token) await r.del(lock.lockKey);
  } catch { /* ignore */ }
}

async function withUsageLock(fn) {
  const gate = 'global';
  while (usageLocks.has(gate)) await usageLocks.get(gate);
  let resolve;
  const p = new Promise(r => { resolve = r; });
  usageLocks.set(gate, p);
  const redisLock = await acquireUsageRedisLock();
  try {
    usageCache = null; // force fresh read while lock is held
    return await fn();
  } finally {
    await releaseUsageRedisLock(redisLock);
    usageLocks.delete(gate);
    resolve();
  }
}

// YYYY-MM bucket key for monthly aggregation. UTC-based so admins in different
// timezones see consistent month boundaries (and so the year-over-year table
// isn't off-by-one for requests near midnight local time).
function monthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export async function logUsage(apiKeyId, { input_tokens, output_tokens, model }) {
  return withUsageLock(async () => {
    const usage = await readUsage();
    const key = apiKeyId || 'unknown';
    if (!usage[key]) usage[key] = { input_tokens: 0, output_tokens: 0, requests: 0, by_model: {}, by_month: {} };
    if (!usage[key].by_model) usage[key].by_model = {};
    if (!usage[key].by_month) usage[key].by_month = {};

    usage[key].input_tokens += input_tokens;
    usage[key].output_tokens += output_tokens;
    usage[key].requests += 1;
    usage[key].last_used = new Date().toISOString();

    if (model) {
      if (!usage[key].by_model[model]) usage[key].by_model[model] = { input_tokens: 0, output_tokens: 0, requests: 0 };
      usage[key].by_model[model].input_tokens += input_tokens;
      usage[key].by_model[model].output_tokens += output_tokens;
      usage[key].by_model[model].requests += 1;
    }

    // Monthly breakdown — same shape as top-level but partitioned by YYYY-MM.
    // Older records (before this field existed) simply won't have historical
    // months; the admin panel renders "Nema podataka" for those.
    const mk = monthKey();
    if (!usage[key].by_month[mk]) {
      usage[key].by_month[mk] = { input_tokens: 0, output_tokens: 0, requests: 0, by_model: {} };
    }
    usage[key].by_month[mk].input_tokens += input_tokens;
    usage[key].by_month[mk].output_tokens += output_tokens;
    usage[key].by_month[mk].requests += 1;
    if (model) {
      if (!usage[key].by_month[mk].by_model[model]) {
        usage[key].by_month[mk].by_model[model] = { input_tokens: 0, output_tokens: 0, requests: 0 };
      }
      usage[key].by_month[mk].by_model[model].input_tokens += input_tokens;
      usage[key].by_month[mk].by_model[model].output_tokens += output_tokens;
      usage[key].by_month[mk].by_model[model].requests += 1;
    }

    await writeUsage(usage);
  });
}

export async function getUsageSummary() {
  return readUsage();
}

export async function getModelStats() {
  const usage = await readUsage();
  const agg = {};
  for (const data of Object.values(usage)) {
    if (!data.by_model) continue;
    for (const [model, stats] of Object.entries(data.by_model)) {
      if (!agg[model]) agg[model] = { input_tokens: 0, output_tokens: 0, requests: 0 };
      agg[model].input_tokens += stats.input_tokens;
      agg[model].output_tokens += stats.output_tokens;
      agg[model].requests += stats.requests;
    }
  }
  return agg;
}

export async function getUsageForKey(keyId) {
  const usage = await readUsage();
  return usage[keyId] || null;
}

/**
 * Aggregate every user's by_month data into a single timeline, computing
 * provider cost, amount charged to the student, and our profit per month.
 *
 * @param {Object} opts
 * @param {(keyId: string) => (boolean|Promise<boolean>)} [opts.isNoMarkup] -
 *   Called per user to decide whether markup applies; defaults to "markup
 *   always applies" if omitted.
 * @param {(model: string, inTok: number, outTok: number) => number}
 *   opts.providerCost - Computes raw provider cost in USD.
 * @param {(model: string) => number} opts.getMarkup - Student-facing markup
 *   multiplier per model (1.0 = no markup).
 * @returns {Promise<Array<{
 *   month: string, requests: number, input_tokens: number,
 *   output_tokens: number, provider_cost_usd: number,
 *   charged_usd: number, profit_usd: number
 * }>>} - Sorted ascending by month (oldest first).
 */
export async function getMonthlyAggregates({ isNoMarkup, providerCost, getMarkup }) {
  const usage = await readUsage();
  const byMonth = {};

  for (const [keyId, data] of Object.entries(usage)) {
    if (!data || !data.by_month) continue;
    const noMarkup = isNoMarkup ? await isNoMarkup(keyId) : false;

    for (const [month, mdata] of Object.entries(data.by_month)) {
      if (!byMonth[month]) {
        byMonth[month] = {
          month,
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          provider_cost_usd: 0,
          charged_usd: 0,
          profit_usd: 0,
        };
      }
      byMonth[month].requests += mdata.requests || 0;
      byMonth[month].input_tokens += mdata.input_tokens || 0;
      byMonth[month].output_tokens += mdata.output_tokens || 0;

      // Walk per-model so the cost and markup apply to the RIGHT model — a
      // month with only Opus calls should cost differently from a month
      // with only Haiku, regardless of the top-level token totals.
      if (mdata.by_model) {
        for (const [model, stats] of Object.entries(mdata.by_model)) {
          const p = providerCost(model, stats.input_tokens || 0, stats.output_tokens || 0);
          byMonth[month].provider_cost_usd += p;
          byMonth[month].charged_usd += noMarkup ? p : p * (getMarkup(model) || 1);
        }
      }
      byMonth[month].profit_usd =
        byMonth[month].charged_usd - byMonth[month].provider_cost_usd;
    }
  }

  // Ascending month order — oldest first so charts / trend lines flow L→R.
  return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
}
