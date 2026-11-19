// Audit of refused MidHub access (`auth.denied { reason }`), throttled so a signed-out browser or a down AgentHub
// cannot flood the audit log: at most one row per reason per 10 minutes per email (or IP when no email is known).
// Never records the AgentHub cookie or anything else from the request but the reason and the email.
import { prisma } from "@/lib/db/client"

export type DenialReason = "signed_out" | "not_admin" | "unreachable" | "locked"

const WINDOW_MS = 10 * 60_000
const MAX_KEYS = 5000
const last = new Map<string, number>()

/** Test hook: forget the throttle state. */
export function resetDenialAudit(): void {
  last.clear()
}

export async function auditDenied(reason: DenialReason, who: { email?: string; ip: string }, now: number = Date.now()): Promise<void> {
  const email = (who.email ?? "").toLowerCase().slice(0, 254)
  const key = `${reason}|${email || `ip:${who.ip}`}`
  const prev = last.get(key)
  if (prev !== undefined && now - prev < WINDOW_MS) return
  if (last.size >= MAX_KEYS) {
    for (const [k, t] of last) if (now - t >= WINDOW_MS) last.delete(k)
    if (last.size >= MAX_KEYS) last.clear()
  }
  last.set(key, now)
  try {
    await prisma.auditLog.create({
      data: { userId: null, email, action: "auth.denied", midName: null, detail: JSON.stringify({ reason }) },
    })
  } catch (err) {
    console.error("[audit] could not store auth.denied:", (err as Error).message)
  }
}
