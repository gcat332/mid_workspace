import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { prisma } from "@/lib/db/client"
import { verifyPassword, signToken, SESSION_COOKIE } from "@/lib/auth/session"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { validLoginNext, LOGIN_NEXT_COOKIE } from "@/lib/auth/login-next"
import { MAX_FAILED_LOGINS } from "@/lib/auth/lockout"
import { recordAuthEvent, clientIp } from "@/lib/auth/auth-log"

// In-memory per-(ip+email) limiter; single instance only.
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5
const attempts = new Map<string, { count: number; first: number }>()

function rateLimited(key: string): boolean {
  const now = Date.now()
  const rec = attempts.get(key)
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: now })
    return false
  }
  rec.count++
  return rec.count > MAX_ATTEMPTS
}

const logRefused = (reason: string, email: string, req: Request): Promise<void> =>
  recordAuthEvent("login_refused", req, { reason, email })

const LOCKED_MESSAGE = "บัญชีถูกล็อกเพราะกรอกรหัสผ่านผิดหลายครั้ง กรุณาติดต่อผู้ดูแลระบบเพื่อปลดล็อก"

export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง (ต้องเป็น JSON)" }, { status: 400 })
  }
  if (typeof body?.email !== "string" || typeof body?.password !== "string" || !body.email || !body.password) {
    return NextResponse.json({ error: "กรุณากรอกอีเมลและรหัสผ่าน" }, { status: 400 })
  }
  const email = body.email.trim().toLowerCase()
  const password = body.password

  const key = `${clientIp(req.headers)}:${email}`
  if (rateLimited(key)) {
    await logRefused("rate_limited", email, req)
    return NextResponse.json({ error: "ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" }, { status: 429 })
  }

  const invalid = (): Response => NextResponse.json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    await logRefused("unknown_email", email, req)
    return invalid()
  }

  // Locked stays locked whatever the password is; only an admin clears it.
  if (user.lockedAt) {
    await logRefused("locked", email, req)
    return NextResponse.json({ error: LOCKED_MESSAGE }, { status: 423 })
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    // Atomic increment so concurrent wrong guesses each count.
    const { failedLoginCount } = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    })
    if (failedLoginCount >= MAX_FAILED_LOGINS) {
      await prisma.user.update({ where: { id: user.id }, data: { lockedAt: new Date() } })
      await logRefused("bad_password_now_locked", email, req)
      return NextResponse.json({ error: LOCKED_MESSAGE }, { status: 423 })
    }
    await logRefused("bad_password", email, req)
    return invalid()
  }

  attempts.delete(key)
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0 } })
  await recordAuthEvent("login_ok", req, { email: user.email })

  const role = user.role === "admin" ? "admin" : "member"
  const token = await signToken({ userId: user.id, email: user.email, role })
  const raw = (await cookies()).get(LOGIN_NEXT_COOKIE)?.value
  const next = validLoginNext(raw)
  const res = NextResponse.json({ email: user.email, role, next })
  // Clear whenever present, valid or not, so a rejected value cannot linger.
  if (raw) res.cookies.set(LOGIN_NEXT_COOKIE, "", { path: "/midhub", maxAge: 0 })
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
  return res
}
