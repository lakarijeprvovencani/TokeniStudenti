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

function readBalances() {
  ensureDataDir();
  if (!fs.existsSync(BALANCES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeBalances(balances) {
  ensureDataDir();
  fs.writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2), 'utf8');
}

/** Get current balance in USD for a key. */
export function getBalance(keyId) {
  const b = readBalances();
  const v = b[keyId];
  return typeof v === 'number' ? v : 0;
}

/** Add credits (e.g. after payment). Returns new balance. */
export function addBalance(keyId, amountUsd) {
  const b = readBalances();
  const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
  const next = Math.round((current + amountUsd) * 100) / 100;
  b[keyId] = next;
  writeBalances(b);
  return next;
}

/** Deduct cost after a request. Returns new balance (can be negative). */
export function deductBalance(keyId, amountUsd) {
  const b = readBalances();
  const current = typeof b[keyId] === 'number' ? b[keyId] : 0;
  const next = Math.round((current - amountUsd) * 100) / 100;
  b[keyId] = next;
  writeBalances(b);
  return next;
}

/**
 * Cene po modelu (Anthropic 2026): Sonnet 4.5/4.6, Opus 4.5/4.6, Haiku 4.5.
 * USD po milion tokena (input, output).
 */
const PRICES = {
  sonnet: { in: 3, out: 15 },   // Sonnet 4, 4.5, 4.6
  opus: { in: 5, out: 25 },     // Opus 4.5, 4.6
  haiku: { in: 1, out: 5 },    // Haiku 4.5
};

function getPriceFromModel(model) {
  const m = (model || process.env.ANTHROPIC_MODEL || '').toLowerCase();
  if (m.includes('opus')) return PRICES.opus;
  if (m.includes('haiku')) return PRICES.haiku;
  return PRICES.sonnet;
}

/**
 * Stvarni trošak kod Anthropic-a (USD) za dati broj tokena.
 */
export function anthropicCostUsd(inputTokens, outputTokens, model) {
  const price = getPriceFromModel(model);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

/**
 * Koliko da skines sa studentovog računa (USD).
 * Ako je STUDENT_MARKUP npr. 1.5, skidamo 1.5× više nego Anthropic – razlika je tvoja zarada.
 * Markup 1 = bez marže (1 USD kredita = 1 USD troška kod Anthropic).
 */
function getStudentMarkup() {
  const v = parseFloat(process.env.STUDENT_MARKUP);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

/** Trošak u USD koji se skida sa studentovog balansa (Anthropic cena × markup). */
export function costUsd(inputTokens, outputTokens, model) {
  const anthropic = anthropicCostUsd(inputTokens, outputTokens, model);
  return Math.round(anthropic * getStudentMarkup() * 100) / 100;
}
