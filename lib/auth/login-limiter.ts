// In-memory per-(ip, email) login rate limiter; single app instance only. Kept on globalThis so every
// route module (login, admin unlock/reset) sees the same map even if bundled separately.

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5

type Rec = { count: number; first: number }
const g = globalThis as unknown as { __midhubLoginLimiter?: Map<string, Map<string, Rec>> }
const byEmail = (g.__midhubLoginLimiter ??= new Map())

export type LimiterHit = { limited: boolean; count: number; retryAfterMinutes: number }

/** Counts one attempt for (ip, email) and says whether it is over the limit. */
export function hitLoginLimiter(ip: string, email: string, now: number = Date.now()): LimiterHit {
  let ips = byEmail.get(email)
  if (!ips) byEmail.set(email, (ips = new Map()))
  let rec = ips.get(ip)
  if (!rec || now - rec.first > WINDOW_MS) ips.set(ip, (rec = { count: 0, first: now }))
  rec.count++
  return {
    limited: rec.count > MAX_ATTEMPTS,
    count: rec.count,
    retryAfterMinutes: Math.max(1, Math.ceil((rec.first + WINDOW_MS - now) / 60_000)),
  }
}

/** Forgets attempts for `email` (from one IP, or all of them): on success, admin unlock or password reset. */
export function clearLoginLimiter(email: string, ip?: string): void {
  if (ip === undefined) byEmail.delete(email)
  else byEmail.get(email)?.delete(ip)
}
