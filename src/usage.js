import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = path.join(__dirname, '..', 'data', 'usage.json');

function ensureDataDir() {
  const dir = path.dirname(USAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readUsage() {
  ensureDataDir();
  if (!fs.existsSync(USAGE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeUsage(usage) {
  ensureDataDir();
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
}

/**
 * Log usage for a student API key.
 * @param {string} apiKeyId - identifier for the key (e.g. last 8 chars or key name)
 * @param {{ input_tokens: number, output_tokens: number }} usage
 */
export function logUsage(apiKeyId, { input_tokens, output_tokens }) {
  const usage = readUsage();
  const key = apiKeyId || 'unknown';
  if (!usage[key]) usage[key] = { input_tokens: 0, output_tokens: 0, requests: 0 };
  usage[key].input_tokens += input_tokens;
  usage[key].output_tokens += output_tokens;
  usage[key].requests += 1;
  usage[key].last_used = new Date().toISOString();
  writeUsage(usage);
}

/**
 * Get usage summary (for admin/stats). Keys are masked.
 */
export function getUsageSummary() {
  return readUsage();
}

/**
 * Get usage for a single key (for dashboard /me).
 * @param {string} keyId
 * @returns {object|null} usage for that key or null
 */
export function getUsageForKey(keyId) {
  const usage = readUsage();
  const data = usage[keyId] || null;
  return data;
}
