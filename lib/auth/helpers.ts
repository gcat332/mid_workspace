import { cookies } from "next/headers"
import { prisma } from "@/lib/db/client"
import { verifyToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth/jwt"
import { isLocked } from "@/lib/auth/lockout"

export const UNAUTHORIZED_MESSAGE = "เซสชันหมดอายุหรือยังไม่ได้เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่"
export const FORBIDDEN_MESSAGE = "ต้องเป็น Admin จึงจะทำรายการนี้ได้"

const jsonResponse = (code: string, message: string, status: number): Response =>
  new Response(JSON.stringify({ code, message }), { status, headers: { "content-type": "application/json" } })

/**
 * The live user behind a session token, or null. The JWT only proves who signed in; role and standing come
 * from the DB so a delete or lock takes effect immediately rather than when the token expires (AgentHub admin
 * standing is re-checked by proxy.ts). Exposed separately from getSessionUser so long-lived streams can re-check
 * the token they started with.
 */
export async function userFromToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  const claims = await verifyToken(token)
  if (!claims) return null
  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { email: true, role: true, lockedAt: true, sessionsValidAfter: true },
  })
  if (!user || isLocked(user.lockedAt)) return null
  if (user.sessionsValidAfter && (claims.authAt ?? 0) < Math.floor(user.sessionsValidAfter.getTime() / 1000)) return null
  const role = user.role === "admin" ? "admin" : "member"
  return { userId: claims.userId, email: user.email, role, authAt: claims.authAt, ahAt: claims.ahAt }
}

/** True when the request carries a valid MidHub token whose user is locked (the access page says why). */
export async function sessionLocked(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const claims = token ? await verifyToken(token) : null
  if (!claims) return false
  const user = await prisma.user.findUnique({ where: { id: claims.userId }, select: { lockedAt: true } })
  return !!user && isLocked(user.lockedAt)
}

export async function getSessionUser(): Promise<SessionPayload | null> {
  return userFromToken((await cookies()).get(SESSION_COOKIE)?.value)
}

/** Throws a 401 Response when not signed in. Callers: `catch (e) { return responseOrRethrow(e) }`. */
export async function requireUser(): Promise<SessionPayload> {
  const user = await getSessionUser()
  if (!user) throw jsonResponse("unauthorized", UNAUTHORIZED_MESSAGE, 401)
  return user
}

/** Throws 401 when not signed in, 403 when not an admin. */
export async function requireAdmin(): Promise<SessionPayload> {
  const user = await requireUser()
  if (user.role !== "admin") throw jsonResponse("forbidden", FORBIDDEN_MESSAGE, 403)
  return user
}

/**
 * For `catch (e) { return responseOrRethrow(e) }` around requireUser/requireAdmin: hands back the
 * thrown 401/403 Response, but rethrows anything else (a real error must surface as a 500, not be
 * returned as if it were a Response).
 */
export function responseOrRethrow(e: unknown): Response {
  if (e instanceof Response) return e
  throw e
}
