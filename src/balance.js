import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');

function ensureDataDir() {
  const dir = path.dirname(BALANCES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let balanceCache = null;
let cacheTime = 0;
const CACHE_TTL = 2000;

function readBalances() {
  ensureDataDir();
  if (balanceCache && (Date.now() - cacheTime < CACHE_TTL)) return balanceCache;
  if (!fs.existsSync(BALANCES_FILE)) return {};
  try {
    balanceCache = JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8'));
    cacheTime = Date.now();
    return balanceCache;
  } catch {
    return {};
  }
}

function writeBalances(balances) {
  ensureDataDir();
  fs.writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2), 'utf8');
  balanceCache = balances;
  cacheTime = Date.now();
}

export function getBalance(keyId) {
  const b = readBalances();
  const v = b[keyId];
  return typeof v === 'number' ? v : 0;
}

export function addBalance(keyId, amountUsd) {
  balanceCache = null;
  const b = readBalances();
  const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
  const next = Math.round((current + amountUsd) * 100) / 100;
  b[keyId] = next;
  writeBalances(b);
  return next;
}

export function deductBalance(keyId, amountUsd) {
  balanceCache = null;
  const b = readBalances();
  const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
  const next = Math.round((current - amountUsd) * 100) / 100;
  b[keyId] = next;
  writeBalances(b);
  return next;
}

/**
 * All model prices: USD per million tokens (input, output).
 * Covers both Anthropic and OpenAI backends.
 */
const PRICES = {
  // OpenAI
  'gpt-4o-mini':       { in: 0.15, out: 0.60 },
  'gpt-4o':            { in: 2.50, out: 10.0 },
  'gpt-4.1-nano':      { in: 0.10, out: 0.40 },
  'gpt-4.1-mini':      { in: 0.40, out: 1.60 },
  'gpt-4.1':           { in: 2.00, out: 8.00 },
  // Anthropic
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

/** Raw provider cost. */
export function providerCostUsd(inputTokens, outputTokens, model) {
  const price = getPrice(model);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

// Keep old name as alias for backward compatibility
export const anthropicCostUsd = providerCostUsd;

function getStudentMarkup() {
  const v = parseFloat(process.env.STUDENT_MARKUP);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

/** Cost deducted from student balance (provider cost x markup). */
export function costUsd(inputTokens, outputTokens, model) {
  const raw = providerCostUsd(inputTokens, outputTokens, model);
  return Math.round(raw * getStudentMarkup() * 1e6) / 1e6;
}
