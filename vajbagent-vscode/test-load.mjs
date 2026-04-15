#!/usr/bin/env node
/**
 * VajbAgent Load Test
 * Tests /me and /v1/chat/completions (streaming) under increasing concurrency.
 */

import https from "node:https";

const API_KEY = "va-nikola-jovanovic-0651badf";
const HOST = "vajbagent.com";
const MODEL = "vajb-agent-lite";
const TIMEOUT_MS = 60_000;
const PAUSE_MS = 2_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted, p) {
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ── request functions ────────────────────────────────────────────────────────

function reqMe() {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.request(
      {
        hostname: HOST,
        path: "/me",
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const ttfb = Date.now() - start;
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            ttfb,
            total: Date.now() - start,
          })
        );
        res.on("error", () =>
          resolve({ ok: false, status: 0, ttfb, total: Date.now() - start, error: "res-error" })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, ttfb: 0, total: Date.now() - start, error: "timeout" });
    });
    req.on("error", (e) =>
      resolve({ ok: false, status: 0, ttfb: 0, total: Date.now() - start, error: e.code || e.message })
    );
    req.end();
  });
}

function reqChat() {
  return new Promise((resolve) => {
    const start = Date.now();
    let ttfb = 0;
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Odgovori sa jednom recenicom: sta je JavaScript?" }],
      stream: true,
    });
    const req = https.request(
      {
        hostname: HOST,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        ttfb = Date.now() - start;
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            ttfb,
            total: Date.now() - start,
          })
        );
        res.on("error", () =>
          resolve({ ok: false, status: 0, ttfb, total: Date.now() - start, error: "res-error" })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, ttfb: 0, total: Date.now() - start, error: "timeout" });
    });
    req.on("error", (e) =>
      resolve({ ok: false, status: 0, ttfb: 0, total: Date.now() - start, error: e.code || e.message })
    );
    req.write(payload);
    req.end();
  });
}

// ── wave runner ──────────────────────────────────────────────────────────────

async function runWave(label, count, fn) {
  process.stdout.write(`\n>> Wave: ${label} (${count} concurrent)...`);
  const results = await Promise.all(Array.from({ length: count }, () => fn()));
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const successRate = (successes.length / results.length) * 100;

  const totals = results.map((r) => r.total).sort((a, b) => a - b);
  const ttfbs = results.map((r) => r.ttfb).sort((a, b) => a - b);

  const errorCounts = {};
  for (const f of failures) {
    const key = f.error || `HTTP ${f.status}`;
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  }

  const stats = {
    label,
    count,
    ok: successes.length,
    fail: failures.length,
    successRate,
    totalMin: totals[0],
    totalAvg: totals.reduce((a, b) => a + b, 0) / totals.length,
    totalMedian: percentile(totals, 50),
    totalMax: totals[totals.length - 1],
    ttfbMin: ttfbs[0],
    ttfbAvg: ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length,
    ttfbMedian: percentile(ttfbs, 50),
    ttfbMax: ttfbs[ttfbs.length - 1],
    errors: errorCounts,
  };

  console.log(` done  [${successes.length}/${results.length} OK, ${successRate.toFixed(0)}%]`);
  console.log(
    `   Total  => min ${fmtMs(stats.totalMin)}  avg ${fmtMs(stats.totalAvg)}  med ${fmtMs(stats.totalMedian)}  max ${fmtMs(stats.totalMax)}`
  );
  console.log(
    `   TTFB   => min ${fmtMs(stats.ttfbMin)}  avg ${fmtMs(stats.ttfbAvg)}  med ${fmtMs(stats.ttfbMedian)}  max ${fmtMs(stats.ttfbMax)}`
  );
  if (Object.keys(errorCounts).length) {
    console.log(`   Errors => ${JSON.stringify(errorCounts)}`);
  }

  return stats;
}

// ── main ─────────────────────────────────────────────────────────────────────

const waves = [
  { label: "GET /me x10",           count: 10,  fn: reqMe },
  { label: "GET /me x25",           count: 25,  fn: reqMe },
  { label: "GET /me x50",           count: 50,  fn: reqMe },
  { label: "POST chat x10",         count: 10,  fn: reqChat },
  { label: "POST chat x25",         count: 25,  fn: reqChat },
  { label: "POST chat x50",         count: 50,  fn: reqChat },
  { label: "GET /me x100",          count: 100, fn: reqMe },
  { label: "POST chat x100",        count: 100, fn: reqChat },
];

console.log("=".repeat(70));
console.log("  VajbAgent Load Test");
console.log("  Target: https://vajbagent.com");
console.log(`  Model:  ${MODEL}`);
console.log(`  Timeout per request: ${TIMEOUT_MS / 1000}s`);
console.log(`  Pause between waves: ${PAUSE_MS / 1000}s`);
console.log("=".repeat(70));

const allStats = [];
let stopped = false;

for (const wave of waves) {
  const stats = await runWave(wave.label, wave.count, wave.fn);
  allStats.push(stats);

  if (stats.successRate < 50) {
    console.log(`\n!! STOPPING: wave "${wave.label}" had ${stats.successRate.toFixed(0)}% success (< 50%). Not sending more traffic.`);
    stopped = true;
    break;
  }

  await sleep(PAUSE_MS);
}

// ── summary table ────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log("  SUMMARY");
console.log("=".repeat(70));

const hdr = [
  "Wave".padEnd(22),
  "OK/Total".padEnd(10),
  "Rate".padEnd(7),
  "Avg".padEnd(9),
  "Med".padEnd(9),
  "Max".padEnd(9),
  "TTFB avg".padEnd(9),
  "Pass?",
].join(" | ");

console.log(hdr);
console.log("-".repeat(hdr.length));

let breakingPoint = null;

for (const s of allStats) {
  const pass = s.successRate >= 90;
  if (!pass && !breakingPoint) breakingPoint = s.label;
  const row = [
    s.label.padEnd(22),
    `${s.ok}/${s.count}`.padEnd(10),
    `${s.successRate.toFixed(0)}%`.padEnd(7),
    fmtMs(s.totalAvg).padEnd(9),
    fmtMs(s.totalMedian).padEnd(9),
    fmtMs(s.totalMax).padEnd(9),
    fmtMs(s.ttfbAvg).padEnd(9),
    pass ? "YES" : "NO",
  ].join(" | ");
  console.log(row);
}

console.log("-".repeat(hdr.length));

if (breakingPoint) {
  console.log(`\nBreaking point: ${breakingPoint}`);
} else {
  console.log("\nAll waves passed (>= 90% success rate). Server handled the full load.");
}

if (stopped) {
  console.log("Test was stopped early due to >50% failure rate.");
}

console.log("\nDone.");
