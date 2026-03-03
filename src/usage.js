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
      const data = await r.get(REDIS_KEY);
      usageCache = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
      usageCacheTime = Date.now();
      if (Object.keys(usageCache).length > 0) return usageCache;
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
  usageCache = usage;
  usageCacheTime = Date.now();
  const r = getRedis();
  if (r) {
    try {
      await r.set(REDIS_KEY, usage);
    } catch (err) {
      console.error('Redis write usage error:', err.message);
    }
  }
  try { writeUsageFile(usage); } catch {}
}

export async function logUsage(apiKeyId, { input_tokens, output_tokens, model }) {
  const usage = await readUsage();
  const key = apiKeyId || 'unknown';
  if (!usage[key]) usage[key] = { input_tokens: 0, output_tokens: 0, requests: 0, by_model: {} };
  if (!usage[key].by_model) usage[key].by_model = {};
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
  await writeUsage(usage);
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
