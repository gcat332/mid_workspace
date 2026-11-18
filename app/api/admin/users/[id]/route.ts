import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { hashPassword } from "@/lib/auth/session"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, jsonError, readJsonObject } from "@/lib/http/route"
import { USER_SELECT, PASSWORD_MIN_ERROR } from "@/lib/auth/user-admin"
import { clearLoginLimiter } from "@/lib/auth/login-limiter"

type Ctx = { params: Promise<{ id: string }> }
const SELF = "ไม่สามารถลดสิทธิ์/ลบบัญชีตัวเองได้"
const LAST_ADMIN = "ต้องมี admin อย่างน้อย 1 คนในระบบ"
const MISSING = () => jsonError("not_found", "ไม่พบผู้ใช้ อาจถูกลบไปแล้ว รีเฟรชหน้าแล้วลองใหม่", 404)

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin()
    const { id } = await params
    const b = (await readJsonObject(req)) ?? {}
    const data: { role?: string; lockedAt?: null; failedLoginCount?: number; passwordHash?: string; sessionsValidAfter?: Date } = {}
    if (b.role !== undefined) {
      if (b.role !== "admin" && b.role !== "member") return jsonError("invalid_role", "สิทธิ์ต้องเป็น admin หรือ member", 400)
      data.role = b.role
    }
    if (b.unlock === true) { data.lockedAt = null; data.failedLoginCount = 0 }
    if (b.password !== undefined) {
      if (typeof b.password !== "string" || b.password.length < 8) return jsonError("weak_password", PASSWORD_MIN_ERROR, 400)
      data.passwordHash = await hashPassword(b.password)
      if (id !== me.userId) data.sessionsValidAfter = new Date() // ends that user's existing sessions
    }
    if (Object.keys(data).length === 0) return jsonError("invalid_request", "ไม่มีข้อมูลที่ต้องแก้ไข", 400)

    if (data.role === "member" && id === me.userId) return jsonError("self", SELF, 400)
    // Count-and-write in one transaction (SQLite serializes writers) so two concurrent demotes/deletes
    // cannot both pass the last-admin check.
    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, role: true } })
      if (!target) return "missing" as const
      if (data.role === "member" && target.role === "admin" && (await tx.user.count({ where: { role: "admin" } })) <= 1) {
        return "last-admin" as const
      }
      return tx.user.update({ where: { id }, data, select: USER_SELECT })
    })
    if (result === "missing") return MISSING()
    if (result === "last-admin") return jsonError("last_admin", LAST_ADMIN, 400)
    const user = result
    // The in-memory login limiter would otherwise keep refusing for up to 15 minutes after an unlock/reset.
    if (data.lockedAt === null || data.passwordHash) clearLoginLimiter(user.email)
    await recordAudit(me, "user.update", undefined, {
      targetEmail: user.email,
      ...(data.role ? { role: data.role } : {}),
      ...(data.lockedAt === null ? { unlock: true } : {}),
      ...(data.passwordHash ? { passwordChanged: true } : {}),
    })
    return NextResponse.json(user)
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin()
    const { id } = await params
    if (id === me.userId) return jsonError("self", SELF, 400)
    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, role: true, email: true } })
      if (!target) return "missing" as const
      if (target.role === "admin" && (await tx.user.count({ where: { role: "admin" } })) <= 1) return "last-admin" as const
      await tx.user.delete({ where: { id } })
      return target
    })
    if (result === "missing") return MISSING()
    if (result === "last-admin") return jsonError("last_admin", LAST_ADMIN, 400)
    await recordAudit(me, "user.delete", undefined, { targetEmail: result.email, role: result.role })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleRouteError(e)
  }
}
