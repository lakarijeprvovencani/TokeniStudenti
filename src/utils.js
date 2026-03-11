export function normalizeIP(ip) {
  if (!ip) return ip;
  return ip.replace(/^::ffff:/, '');
}

export const WHITELIST_IPS = new Set(
  (process.env.WHITELIST_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
);
