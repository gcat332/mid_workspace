import { IDLE_TIMEOUT_SECONDS } from "@/lib/auth/jwt"

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/midhub",
    maxAge: IDLE_TIMEOUT_SECONDS,
  }
}
