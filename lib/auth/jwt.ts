// JWT sign/verify — dependency-light so it is safe for both Node and Edge runtimes.
// No bcryptjs or Node-only imports here; password hashing lives in session.ts.

import * as jose from "jose"
import { getJwtSecret } from "@/lib/auth/secret"

export interface SessionPayload {
  userId: string
  email: string
  role: "admin" | "member"
}

export const SESSION_COOKIE = "midhub_session"
export const SESSION_TOKEN_ISSUER = "bsm-midhub/session"
// Sliding idle timeout: the token is minted with this lifetime and re-issued on activity.
export const IDLE_TIMEOUT_SECONDS = 4 * 60 * 60

export async function signToken(payload: SessionPayload): Promise<string> {
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${IDLE_TIMEOUT_SECONDS}s`)
    .sign(getJwtSecret())
}

/** Verifies signature, pinned alg + issuer, and the payload shape. Returns null on any failure. */
export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
      algorithms: ["HS256"],
      issuer: SESSION_TOKEN_ISSUER,
    })
    if (payload.purpose !== undefined) return null
    if (
      typeof payload.userId !== "string" || !payload.userId ||
      typeof payload.email !== "string" ||
      (payload.role !== "admin" && payload.role !== "member")
    ) {
      return null
    }
    return { userId: payload.userId, email: payload.email, role: payload.role }
  } catch {
    return null
  }
}
