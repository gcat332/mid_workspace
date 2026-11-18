// Password-login lockout policy. Client-safe: no imports.

/** Consecutive wrong passwords before the account locks. */
export const MAX_FAILED_LOGINS = 3
/** A lock expires on its own after this long (an admin can also unlock; a service restart unlocks ADMIN_EMAIL). */
export const LOCK_MINUTES = 15
const LOCK_MS = LOCK_MINUTES * 60 * 1000

/** Is a lock set at `lockedAt` still in force at `now`? An expired lock counts as unlocked. */
export function isLocked(lockedAt: Date | string | null | undefined, now: number = Date.now()): boolean {
  if (!lockedAt) return false
  const at = new Date(lockedAt).getTime()
  return Number.isNaN(at) || now - at < LOCK_MS
}

/** Whole minutes (at least 1) until a lock set at `lockedAt` expires. */
export function lockMinutesLeft(lockedAt: Date | string, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((new Date(lockedAt).getTime() + LOCK_MS - now) / 60_000))
}
