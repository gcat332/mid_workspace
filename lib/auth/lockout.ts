// MidHub-side account lock. Client-safe: no imports.
// Sign-in is through AgentHub, so there is no password lockout any more: a lock is set by an admin under
// Admin -> ผู้ใช้ and stays until an admin unlocks it, even while AgentHub still says the user is an admin.

/** Is the account locked? Any set (or unparseable) lockedAt counts as locked. */
export function isLocked(lockedAt: Date | string | null | undefined): boolean {
  return Boolean(lockedAt)
}
