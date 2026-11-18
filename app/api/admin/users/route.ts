import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { requireAdmin } from "@/lib/auth/helpers"
import { hashPassword } from "@/lib/auth/session"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, jsonError, readJsonObject } from "@/lib/http/route"
import { USER_SELECT, PASSWORD_MIN_ERROR } from "@/lib/auth/user-admin"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DUP = "มีผู้ใช้อีเมลนี้อยู่แล้ว"

export async function GET() {
  try {
    await requireAdmin()
    const users = await prisma.user.findMany({ select: USER_SELECT, orderBy: { createdAt: "asc" } })
    return NextResponse.json(users)
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireAdmin()
    const b = (await readJsonObject(req)) ?? {}
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : ""
    if (!EMAIL_RE.test(email)) return jsonError("invalid_email", "รูปแบบอีเมลไม่ถูกต้อง", 400)
    if (b.role !== "admin" && b.role !== "member") return jsonError("invalid_role", "สิทธิ์ต้องเป็น admin หรือ member", 400)
    const role = b.role
    let password: string
    const ssoOnly = b.password === undefined || b.password === ""
    if (ssoOnly) {
      // SSO-only: a bcrypt hash of a random secret nobody knows, so local login can never succeed.
      password = randomBytes(32).toString("hex")
    } else if (typeof b.password === "string" && b.password.length >= 8) {
      password = b.password
    } else {
      return jsonError("weak_password", PASSWORD_MIN_ERROR, 400)
    }
    if (await prisma.user.findUnique({ where: { email } })) return jsonError("conflict", DUP, 409)
    try {
      const user = await prisma.user.create({
        data: { email, role, passwordHash: await hashPassword(password) },
        select: USER_SELECT,
      })
      await recordAudit(me, "user.create", undefined, { targetEmail: email, role, ssoOnly })
      return NextResponse.json(user, { status: 201 })
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return jsonError("conflict", DUP, 409)
      throw e
    }
  } catch (e) {
    return handleRouteError(e)
  }
}
