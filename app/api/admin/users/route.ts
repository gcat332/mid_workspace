import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { requireAdmin, responseOrRethrow } from "@/lib/auth/helpers"
import { hashPassword } from "@/lib/auth/session"
import { prisma } from "@/lib/db/client"
import { USER_SELECT, PASSWORD_MIN_ERROR } from "@/lib/auth/user-admin"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DUP = "มีผู้ใช้อีเมลนี้อยู่แล้ว"

export async function GET() {
  try { await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const users = await prisma.user.findMany({ select: USER_SELECT, orderBy: { createdAt: "asc" } })
  return NextResponse.json(users)
}

export async function POST(req: Request) {
  try { await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; role?: unknown; password?: unknown }
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : ""
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "รูปแบบอีเมลไม่ถูกต้อง" }, { status: 400 })
  if (b.role !== "admin" && b.role !== "member") {
    return NextResponse.json({ error: "สิทธิ์ต้องเป็น admin หรือ member" }, { status: 400 })
  }
  let password: string
  if (b.password === undefined || b.password === "") {
    // SSO-only: a bcrypt hash of a random secret nobody knows, so local login can never succeed.
    password = randomBytes(32).toString("hex")
  } else if (typeof b.password === "string" && b.password.length >= 8) {
    password = b.password
  } else {
    return NextResponse.json({ error: PASSWORD_MIN_ERROR }, { status: 400 })
  }
  if (await prisma.user.findUnique({ where: { email } })) return NextResponse.json({ error: DUP }, { status: 409 })
  try {
    const user = await prisma.user.create({
      data: { email, role: b.role, passwordHash: await hashPassword(password) },
      select: USER_SELECT,
    })
    return NextResponse.json(user, { status: 201 })
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return NextResponse.json({ error: DUP }, { status: 409 })
    throw e
  }
}
