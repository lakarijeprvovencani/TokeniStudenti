// Virtual-currency helper — internal accounting stays in USD on the
// backend, but the UI shows a friendlier "credits" number. Keep the rate
// here so a single place controls the conversion.

export const CREDITS_PER_USD = 1000

export function toCredits(usd: number): number {
  if (!Number.isFinite(usd)) return 0
  return Math.max(0, Math.round(usd * CREDITS_PER_USD))
}

export function formatCredits(usd: number): string {
  return toCredits(usd).toLocaleString('sr-RS')
}
