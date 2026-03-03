import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRedis, isRedisConfigured } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const REDIS_KEY = 'vajb:balances';

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
      const res = await r.set(REDIS_KEY, balances);
      console.log('Redis write balances result:', res);
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

export async function addBalance(keyId, amountUsd) {
  balanceCache = null;
  const b = await readBalances();
  const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
  const next = Math.round((current + amountUsd) * 100) / 100;
  b[keyId] = next;
  await writeBalances(b);
  return next;
}

export async function deductBalance(keyId, amountUsd) {
  balanceCache = null;
  const b = await readBalances();
  const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
  const next = Math.round((current - amountUsd) * 100) / 100;
  b[keyId] = next;
  console.log(`deductBalance: ${keyId} ${current} - ${amountUsd} = ${next}`);
  await writeBalances(b);
  return next;
}

/**
 * All model prices: USD per million tokens (input, output).
 */
const PRICES = {
  'gpt-4o-mini':       { in: 0.15, out: 0.60 },
  'gpt-4o':            { in: 2.50, out: 10.0 },
  'gpt-4.1-nano':      { in: 0.10, out: 0.40 },
  'gpt-4.1-mini':      { in: 0.40, out: 1.60 },
  'gpt-4.1':           { in: 2.00, out: 8.00 },
  'claude-haiku-4-5':  { in: 1.00, out: 5.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.0 },
  'claude-opus-4-6':   { in: 5.00, out: 25.0 },
  'claude-sonnet-4-5': { in: 3.00, out: 15.0 },
  'claude-opus-4-5':   { in: 5.00, out: 25.0 },
};

const DEFAULT_PRICE = { in: 3, out: 15 };

function getPrice(model) {
  if (model && PRICES[model]) return PRICES[model];
  const m = (model || '').toLowerCase();
  if (m.includes('opus'))   return PRICES['claude-opus-4-6'];
  if (m.includes('haiku'))  return PRICES['claude-haiku-4-5'];
  if (m.includes('sonnet')) return PRICES['claude-sonnet-4-6'];
  if (m.includes('4o-mini') || m.includes('4.1-nano')) return PRICES['gpt-4o-mini'];
  if (m.includes('gpt-4o') || m.includes('4.1-mini')) return PRICES['gpt-4o'];
  return DEFAULT_PRICE;
}

export function providerCostUsd(inputTokens, outputTokens, model) {
  const price = getPrice(model);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

export const anthropicCostUsd = providerCostUsd;

function getStudentMarkup() {
  const v = parseFloat(process.env.STUDENT_MARKUP);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

export function costUsd(inputTokens, outputTokens, model) {
  const raw = providerCostUsd(inputTokens, outputTokens, model);
  return Math.round(raw * getStudentMarkup() * 1e6) / 1e6;
}
