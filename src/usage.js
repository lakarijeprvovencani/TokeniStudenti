import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

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
 * Log usage for a student API key, optionally tracking per-model usage.
 * @param {string} apiKeyId - identifier for the key
 * @param {{ input_tokens: number, output_tokens: number, model?: string }} usageData
 */
export function logUsage(apiKeyId, { input_tokens, output_tokens, model }) {
  const usage = readUsage();
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
  writeUsage(usage);
}

/**
 * Get usage summary (for admin/stats).
 */
export function getUsageSummary() {
  return readUsage();
}

/**
 * Aggregate per-model stats across all users.
 * @returns {Record<string, {input_tokens:number, output_tokens:number, requests:number}>}
 */
export function getModelStats() {
  const usage = readUsage();
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
