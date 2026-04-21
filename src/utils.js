export function normalizeIP(ip) {
  if (!ip) return ip;
  return ip.replace(/^::ffff:/, '');
}

/**
 * Return the REAL client IP when the request came through a proxy
 * chain (Cloudflare → Render → Express). Preference order:
 *   1. `CF-Connecting-IP` — Cloudflare always sets this to the
 *      original visitor IP; it cannot be spoofed by the client
 *      because Cloudflare overwrites any value the client sends.
 *   2. `X-Real-IP` — some other proxies set this.
 *   3. `req.ip` — Express's parsed X-Forwarded-For output. With our
 *      `trust proxy` setting, this points at the Render edge, NOT
 *      the real client, when Cloudflare is in front. Use as a last
 *      resort only.
 *
 * Without this helper, forensic logs and rate-limit counters silently
 * group all traffic under Cloudflare's own edge-server IPs (the
 * 172.68.x.x / 172.70.x.x / 104.16.x.x ranges), making per-IP and
 * per-/24 defences effectively useless — a single attacker shows up
 * as dozens of different "IPs" spread around the world, each
 * well-below our per-IP caps.
 */
export function getClientIP(req) {
  if (!req) return null;
  const h = req.headers || {};
  const cf = h['cf-connecting-ip'];
  if (cf && typeof cf === 'string') return normalizeIP(cf.trim());
  const xri = h['x-real-ip'];
  if (xri && typeof xri === 'string') return normalizeIP(xri.trim());
  return normalizeIP(req.ip || req.connection?.remoteAddress || '');
}

export const WHITELIST_IPS = new Set(
  (process.env.WHITELIST_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
);
