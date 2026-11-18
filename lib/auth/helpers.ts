import { cookies } from "next/headers"
import { verifyToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth/jwt"

const jsonResponse = (error: string, status: number): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } })

export async function getSessionUser(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifyToken(token)
}

/** Throws a 401 Response when not signed in. Callers: `catch (e) { return responseOrRethrow(e) }`. */
export async function requireUser(): Promise<SessionPayload> {
  const user = await getSessionUser()
  if (!user) throw jsonResponse("Unauthorized", 401)
  return user
}

/** Throws 401 when not signed in, 403 when not an admin. */
export async function requireAdmin(): Promise<SessionPayload> {
  const user = await requireUser()
  if (user.role !== "admin") throw jsonResponse("Forbidden", 403)
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
