/** Pure helpers for LogTab (kept out of the component so they can be unit tested). */

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 30_000

/** Exponential backoff: 1 s, 2 s, 4 s ... capped at 30 s. `attempt` counts failures since the last good frame. */
export const nextBackoff = (attempt: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))

/** 4xx (except 408/429) are permanent: show the error, do not retry. */
export const shouldRetry = (httpStatus: number): boolean => httpStatus < 400 || httpStatus >= 500 || httpStatus === 408 || httpStatus === 429

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Level token as a whole word (so "ERRORS" or "NOWARNING" do not match). Empty level matches everything. */
export function levelMatches(text: string, level: string): boolean {
  return !level || new RegExp(`\\b${escapeRe(level)}\\b`).test(text)
}
