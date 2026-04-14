#!/usr/bin/env node
/**
 * Post-install hook: build the Vite SPA (vajbagent-web) after the root
 * dependencies are installed. This runs on Render regardless of what the
 * dashboard's Build Command is set to, so the web app is always shipped
 * alongside the backend.
 *
 * Guards:
 *  - Skip when SKIP_WEB_BUILD=1 (for quick local installs).
 *  - Skip when vajbagent-web/ is missing (defensive for sparse checkouts).
 *  - Skip recursive runs triggered by the nested `npm install` inside
 *    vajbagent-web so we don't loop forever.
 *  - Never fail the parent install — a build error logs a big warning
 *    but the backend can still boot (it falls back to extenzija.html).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const webDir = path.join(root, 'vajbagent-web');
const distIndex = path.join(webDir, 'dist', 'index.html');

// Idempotent: if the bundle is already built and newer than the source,
// skip. This lets the same script be used for `postinstall` (fresh
// install → build) AND `prestart` (fast no-op if postinstall already
// did the work, but safety net if it didn't).
if (existsSync(distIndex)) {
  const srcEntry = path.join(webDir, 'src', 'main.tsx');
  if (existsSync(srcEntry)) {
    const distMtime = statSync(distIndex).mtimeMs;
    const srcMtime = statSync(srcEntry).mtimeMs;
    if (distMtime >= srcMtime) {
      console.log('[postinstall] dist/index.html is fresh — skipping build.');
      process.exit(0);
    }
  }
}

if (process.env.SKIP_WEB_BUILD === '1') {
  console.log('[postinstall] SKIP_WEB_BUILD=1 — skipping web build.');
  process.exit(0);
}
if (process.env.VAJB_WEB_BUILD_RUNNING === '1') {
  // Nested install triggered by this very script — skip.
  process.exit(0);
}
if (!existsSync(webDir) || !statSync(webDir).isDirectory()) {
  console.log('[postinstall] vajbagent-web/ not found — skipping.');
  process.exit(0);
}

console.log('[postinstall] Building vajbagent-web SPA…');
const env = { ...process.env, VAJB_WEB_BUILD_RUNNING: '1' };

// 1. Install web app deps — force dev deps because Render sets NODE_ENV=production
// which would otherwise skip vite, typescript, @vitejs/plugin-react, etc.
const install = spawnSync('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...env, NODE_ENV: 'development' },
  shell: process.platform === 'win32',
});
if (install.status !== 0) {
  console.error('[postinstall] vajbagent-web `npm install` failed — backend will fall back to extenzija.html');
  process.exit(0); // never block the root install
}

// 2. Build (keep NODE_ENV=development during the build so tsc/vite can
// still resolve devDependencies from node_modules)
const build = spawnSync('npm', ['run', 'build'], {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...env, NODE_ENV: 'development' },
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  console.error('[postinstall] vajbagent-web build failed — backend will fall back to extenzija.html');
  process.exit(0);
}

if (!existsSync(distIndex)) {
  console.error('[postinstall] Build finished but dist/index.html missing — fallback will trigger.');
  process.exit(0);
}
console.log('[postinstall] ✓ Web app built:', distIndex);
