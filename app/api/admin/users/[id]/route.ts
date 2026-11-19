import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, jsonError, readJsonObject } from "@/lib/http/route"
import { USER_SELECT } from "@/lib/auth/user-admin"

type Ctx = { params: Promise<{ id: string }> }

/**
 * PATCH {lock: true} | {unlock: true}: the only change an admin can make to a user. A lock denies MidHub even
 * while AgentHub still says admin, and lasts until unlocked. Role, password, create and delete are gone (sign-in
 * is through AgentHub; everyone who signs in is an AgentHub admin).
 */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin()
    const { id } = await params
    const b = (await readJsonObject(req)) ?? {}
    const keys = Object.keys(b)
    const lock = keys.length === 1 && b.lock === true
    const unlock = keys.length === 1 && b.unlock === true
    if (!lock && !unlock) return jsonError("invalid_request", "ส่งได้เฉพาะ {lock: true} หรือ {unlock: true}", 400)
    if (lock && id === me.userId) return jsonError("self", "ไม่สามารถล็อกบัญชีตัวเองได้", 400)
    let user
    try {
      user = await prisma.user.update({
        where: { id },
        data: lock ? { lockedAt: new Date() } : { lockedAt: null, failedLoginCount: 0 },
        select: USER_SELECT,
      })
    } catch (e) {
      if ((e as { code?: string }).code === "P2025") {
        return jsonError("not_found", "ไม่พบผู้ใช้ อาจถูกลบไปแล้ว รีเฟรชหน้าแล้วลองใหม่", 404)
      }
      throw e
    }
    await recordAudit(me, "user.update", undefined, { targetEmail: user.email, ...(lock ? { lock: true } : { unlock: true }) })
    return NextResponse.json(user)
  } catch (e) {
    return handleRouteError(e)
  }
}

// The corporate F5 WAF in front of the domain rejects every PATCH (its "Request Rejected" page, status 200), so
// the browser sends POST; PATCH stays for API clients that are not behind it.
export const POST = PATCH
