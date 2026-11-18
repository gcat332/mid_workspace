import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { prisma } from "@/lib/db/client"
import { verifyPassword, signToken, SESSION_COOKIE } from "@/lib/auth/session"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { validLoginNext, LOGIN_NEXT_COOKIE } from "@/lib/auth/login-next"
import { isLocked, lockMinutesLeft, LOCK_MINUTES, MAX_FAILED_LOGINS } from "@/lib/auth/lockout"
import { clearLoginLimiter, hitLoginLimiter } from "@/lib/auth/login-limiter"
import { recordAuthEvent } from "@/lib/auth/auth-log"
import { clientIpFrom } from "@/lib/net/cidr"
import { jsonError } from "@/lib/http/route"

// Error bodies use the app's { code, message } shape; the login page shows `message` itself (no 401 redirect).
const logRefused = (reason: string, email: string, req: Request): Promise<void> =>
  recordAuthEvent("login_refused", req, { reason, email })

const locked = (minutes: number): Response =>
  jsonError("locked", `บัญชีถูกล็อกชั่วคราว ${LOCK_MINUTES} นาทีเพราะกรอกรหัสผ่านผิด ${MAX_FAILED_LOGINS} ครั้ง ` +
    `รออีกประมาณ ${minutes} นาทีแล้วลองใหม่ หรือติดต่อผู้ดูแลระบบให้ปลดล็อก`, 423)

/** Same body for an unknown email and a wrong password (only the remaining count differs by attempt number). */
const invalid = (remaining: number): Response =>
  jsonError("invalid_credentials", `อีเมลหรือรหัสผ่านไม่ถูกต้อง (เหลืออีก ${remaining} ครั้งก่อนบัญชีถูกล็อก)`, 401)

export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonError("invalid_request", "คำขอไม่ถูกต้อง (ต้องเป็น JSON) กรุณารีเฟรชหน้าแล้วลองใหม่", 400)
  }
  if (typeof body?.email !== "string" || typeof body?.password !== "string" || !body.email || !body.password) {
    return jsonError("invalid_request", "กรุณากรอกอีเมลและรหัสผ่าน", 400)
  }
  const email = body.email.trim().toLowerCase()
  const password = body.password
  const ip = clientIpFrom(req.headers) || "unknown"

  const hit = hitLoginLimiter(ip, email)
  if (hit.limited) {
    await logRefused("rate_limited", email, req)
    return jsonError("rate_limited", `ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอประมาณ ${hit.retryAfterMinutes} นาทีแล้วลองใหม่`, 429)
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    await logRefused("unknown_email", email, req)
    return invalid(Math.max(1, MAX_FAILED_LOGINS - hit.count))
  }

  // Locked stays locked whatever the password is, until it expires or an admin unlocks it.
  if (isLocked(user.lockedAt)) {
    await logRefused("locked", email, req)
    return locked(lockMinutesLeft(user.lockedAt!))
  }
  if (user.lockedAt) {
    // Expired lock: start counting again from zero.
    await prisma.user.update({ where: { id: user.id }, data: { lockedAt: null, failedLoginCount: 0 } })
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
      return locked(LOCK_MINUTES)
    }
    await logRefused("bad_password", email, req)
    return invalid(MAX_FAILED_LOGINS - failedLoginCount)
  }

  clearLoginLimiter(email, ip)
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
