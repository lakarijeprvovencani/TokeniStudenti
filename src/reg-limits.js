// Registration flood controls beyond per-IP.
//
// Attackers rotate through hundreds of IPs, so per-IP limits alone
// can't stop a burst. This module adds three coarse-grained brakes:
//
//   1. Global kill switch — env var REGISTRATION_DISABLED=1 OR Redis
//      key `vajb:reg:kill` (admin togglable at runtime).
//   2. Global hourly / daily cap — total new accounts per hour/day
//      across ALL IPs. Configurable via REGISTRATION_HOURLY_CAP /
//      REGISTRATION_DAILY_CAP (defaults 15/hr, 50/day).
//   3. Per-/24 subnet cap — same first three octets can't register
//      more than REGISTRATION_SUBNET_DAILY_CAP times per day
//      (default 3). Botnets tend to cluster in a few ASNs/subnets.
//
// All counters live in Redis (Upstash) with natural TTLs so there's
// no cleanup job. If Redis isn't configured, caps silently disable
// themselves (kill switch still works via env var).

import { getRedis } from './redis.js';
import { normalizeIP, WHITELIST_IPS } from './utils.js';
import geoip from 'geoip-lite';

const KILL_KEY = 'vajb:reg:kill';
const HOURLY_PREFIX = 'vajb:reg:hour:';
const DAILY_PREFIX = 'vajb:reg:day:';
const SUBNET_PREFIX = 'vajb:reg:subnet:';
const DOMAIN_PREFIX = 'vajb:reg:domain:'; // per email-domain daily cap
const DENIED_PREFIX = 'vajb:reg:denied:';
const RECENT_DENIED_KEY = 'vajb:reg:recent_denied'; // Redis list (LPUSH, capped)
const RECENT_DENIED_MAX = 200; // keep last N blocked attempts for inspection

const HOURLY_TTL = 60 * 60 * 2; // 2h — generous retention for stats
const DAILY_TTL = 60 * 60 * 36; // 36h
const SUBNET_TTL = 60 * 60 * 36;
const DOMAIN_TTL = 60 * 60 * 36;
const DENIED_TTL = 60 * 60 * 36;

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function getLimits() {
  // Defaults tightened after the 22 Apr bot-wave that slipped
  // through at the old 15/50/3 levels. If you run a legit promo and
  // need more signups per hour, bump these in Render env vars.
  return {
    hourly: intEnv('REGISTRATION_HOURLY_CAP', 5),
    daily: intEnv('REGISTRATION_DAILY_CAP', 20),
    subnet_daily: intEnv('REGISTRATION_SUBNET_DAILY_CAP', 2),
    // Per email-domain cap — stops single-provider floods (e.g. every
    // account is @outlook.com) without touching legit multi-domain
    // traffic. Legit users are spread across gmail/yahoo/icloud/etc
    // so 3/day is generous.
    domain_daily: intEnv('REGISTRATION_DOMAIN_DAILY_CAP', 3),
    kill_env: process.env.REGISTRATION_DISABLED === '1',
  };
}

function emailDomain(email) {
  if (!email || typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).trim().toLowerCase();
}

function hourKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  return `${y}${m}${d}${h}`;
}

function dayKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// /24 subnet = first three octets of IPv4. IPv6 gets grouped by /64.
function subnetOf(ip) {
  const n = normalizeIP(ip || '');
  if (!n) return '';
  if (n.includes(':')) {
    // IPv6 — take first 4 groups (roughly /64).
    const groups = n.split(':').slice(0, 4).join(':');
    return 'v6:' + groups;
  }
  const parts = n.split('.');
  if (parts.length !== 4) return '';
  return parts.slice(0, 3).join('.') + '.0/24';
}

async function isKilled() {
  if (process.env.REGISTRATION_DISABLED === '1') return true;
  const r = getRedis();
  if (!r) return false;
  try {
    const v = await r.get(KILL_KEY);
    return v === '1' || v === 1 || v === true;
  } catch {
    return false;
  }
}

export async function setKilled(value) {
  const r = getRedis();
  if (!r) throw new Error('Redis nije konfigurisan — kill switch se ne može ukljičiti kroz UI.');
  if (value) await r.set(KILL_KEY, '1');
  else await r.del(KILL_KEY);
}

/**
 * Decide whether to let a registration through. Returns
 *   { ok: true }  — proceed
 *   { ok: false, reason: 'killed' | 'global_hourly' | 'global_daily' | 'subnet_daily' | 'domain_daily' }
 *
 * Whitelisted IPs bypass all caps (but still honor kill switch so the
 * admin can shut everything off in an emergency).
 *
 * `email` is optional — when provided, the per-domain daily cap is
 * enforced. This stops single-provider floods (every bot uses the
 * same @outlook.com / @gmail.com) without touching legit multi-domain
 * traffic.
 */
export async function checkRegistrationAllowed(ip, email) {
  if (await isKilled()) return { ok: false, reason: 'killed' };

  const ipNorm = normalizeIP(ip || '');
  const isWL = WHITELIST_IPS.has(ipNorm);
  const limits = getLimits();
  const r = getRedis();
  if (!r) return { ok: true }; // no Redis → caps disabled silently

  const domain = emailDomain(email);

  try {
    const reads = [
      r.get(HOURLY_PREFIX + hourKey()),
      r.get(DAILY_PREFIX + dayKey()),
      r.get(SUBNET_PREFIX + dayKey() + ':' + subnetOf(ipNorm)),
    ];
    if (domain) {
      reads.push(r.get(DOMAIN_PREFIX + dayKey() + ':' + domain));
    }
    const results = await Promise.all(reads);
    const h = Number(results[0] || 0);
    const d = Number(results[1] || 0);
    const s = Number(results[2] || 0);
    const dom = domain ? Number(results[3] || 0) : 0;
    if (!isWL) {
      if (h >= limits.hourly) return { ok: false, reason: 'global_hourly' };
      if (d >= limits.daily) return { ok: false, reason: 'global_daily' };
      if (s >= limits.subnet_daily) return { ok: false, reason: 'subnet_daily' };
      if (domain && dom >= limits.domain_daily) {
        return { ok: false, reason: 'domain_daily' };
      }
    }
    return { ok: true };
  } catch (err) {
    console.warn('[RegLimits] check failed, allowing through:', err?.message);
    return { ok: true };
  }
}

export async function recordRegistration(ip, email) {
  const r = getRedis();
  if (!r) return;
  const subnet = subnetOf(ip);
  const domain = emailDomain(email);
  try {
    const hKey = HOURLY_PREFIX + hourKey();
    const dKey = DAILY_PREFIX + dayKey();
    const sKey = SUBNET_PREFIX + dayKey() + ':' + subnet;
    const ops = [
      r.incr(hKey).then(() => r.expire(hKey, HOURLY_TTL)),
      r.incr(dKey).then(() => r.expire(dKey, DAILY_TTL)),
      r.incr(sKey).then(() => r.expire(sKey, SUBNET_TTL)),
    ];
    if (domain) {
      const domKey = DOMAIN_PREFIX + dayKey() + ':' + domain;
      ops.push(r.incr(domKey).then(() => r.expire(domKey, DOMAIN_TTL)));
    }
    await Promise.all(ops);
  } catch (err) {
    console.warn('[RegLimits] record failed:', err?.message);
  }
}

/**
 * Map the raw IP to a short geo/ASN hint. Uses the bundled MaxMind
 * GeoLite2 snapshot via geoip-lite (fully offline, ~50MB data). If
 * the request came through Cloudflare (orange-cloud proxy), we
 * prefer its headers — they're always correct even when the edge
 * gives us a private/proxy IP.
 */
function geoLookup(ip, req) {
  const out = { country: null, region: null, city: null };
  if (req) {
    const cfCountry = req.headers?.['cf-ipcountry'];
    if (cfCountry && cfCountry !== 'XX') out.country = String(cfCountry).toUpperCase();
  }
  if (!ip) return out;
  try {
    const g = geoip.lookup(normalizeIP(ip));
    if (g) {
      if (!out.country) out.country = g.country || null;
      out.region = g.region || null;
      out.city = g.city || null;
    }
  } catch {}
  return out;
}

export async function recordDenied(reason, ip, req) {
  const r = getRedis();
  if (!r) return;
  try {
    const k = DENIED_PREFIX + dayKey() + ':' + (reason || 'unknown');
    await r.incr(k);
    await r.expire(k, DENIED_TTL);

    // Store individual entry for forensics — last 200 blocked attempts
    // with IP, geo, subnet, and a trimmed user-agent so the admin can
    // see exactly where an attack is coming from.
    if (ip) {
      const geo = geoLookup(ip, req);
      const uaRaw = req?.headers?.['user-agent'] || '';
      const ua = typeof uaRaw === 'string' ? uaRaw.slice(0, 180) : '';
      const entry = {
        t: Date.now(),
        ip: normalizeIP(ip),
        subnet: subnetOf(ip),
        reason,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        ua,
      };
      await r.lpush(RECENT_DENIED_KEY, JSON.stringify(entry));
      await r.ltrim(RECENT_DENIED_KEY, 0, RECENT_DENIED_MAX - 1);
      await r.expire(RECENT_DENIED_KEY, DENIED_TTL);
    }
  } catch {}
}

/**
 * Return the most recent blocked attempts (newest first) so the
 * admin UI can inspect them. Returns [] if Redis isn't configured
 * or the list is empty.
 */
export async function getRecentDenied(limit = 100) {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.lrange(RECENT_DENIED_KEY, 0, Math.min(limit, RECENT_DENIED_MAX) - 1);
    return (raw || []).map(s => {
      try { return typeof s === 'string' ? JSON.parse(s) : s; }
      catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * For admin dashboard: snapshot of current registration traffic.
 */
export async function getStats() {
  const limits = getLimits();
  const r = getRedis();
  const out = {
    limits,
    kill_env: limits.kill_env,
    kill_redis: false,
    current_hour: 0,
    current_day: 0,
    denied_today: {},
    top_subnets_today: [],
  };
  if (!r) return out;
  try {
    const [killVal, hourVal, dayVal] = await Promise.all([
      r.get(KILL_KEY),
      r.get(HOURLY_PREFIX + hourKey()),
      r.get(DAILY_PREFIX + dayKey()),
    ]);
    out.kill_redis = killVal === '1' || killVal === 1 || killVal === true;
    out.current_hour = Number(hourVal || 0);
    out.current_day = Number(dayVal || 0);

    // Denied counters per reason. We only look for the known reason
    // codes — no wildcards needed.
    const reasons = ['killed', 'global_hourly', 'global_daily', 'subnet_daily',
                     'domain_daily', 'honeypot', 'bad_token', 'turnstile',
                     'per_ip', 'bad_input'];
    const vals = await Promise.all(
      reasons.map(x => r.get(DENIED_PREFIX + dayKey() + ':' + x))
    );
    for (let i = 0; i < reasons.length; i++) {
      const n = Number(vals[i] || 0);
      if (n > 0) out.denied_today[reasons[i]] = n;
    }
  } catch (err) {
    out.error = err?.message;
  }
  return out;
}
