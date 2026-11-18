import { prisma } from "@/lib/db/client"
import type { SessionPayload } from "@/lib/auth/jwt"

/** Writes an AuditLog row. Never throws: a failed audit write is logged and must not fail the action. */
export async function recordAudit(
  user: SessionPayload,
  action: string,
  midName?: string,
  detail: object = {},
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { userId: user.userId, email: user.email, action, midName: midName ?? null, detail: JSON.stringify(detail) },
    })
  } catch (err) {
    console.error("[audit] could not store audit entry:", (err as Error).message)
  }
}
