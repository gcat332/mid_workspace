import bcrypt from "bcryptjs"

export {
  signToken,
  verifyToken,
  SESSION_COOKIE,
  SESSION_TOKEN_ISSUER,
  IDLE_TIMEOUT_SECONDS,
  type SessionPayload,
} from "@/lib/auth/jwt"

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}
