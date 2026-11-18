import { prisma } from "@/lib/db/client"
import { clientIpFrom } from "@/lib/net/cidr"

export type AuthEventName = "login_ok" | "login_refused" | "sso_ok" | "sso_failed" | "unlocked"
export const FAILED_EVENTS: AuthEventName[] = ["login_refused", "sso_failed"]

// Client-supplied text (email, IdP error, user-agent) is stripped of control characters and
// length-capped so a forged newline cannot fake a second log line.
const clean = (v: string, max: number): string => v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max)


export async function recordAuthEvent(
  event: AuthEventName,
  req: Request,
  fields: { reason?: string; email?: string; detail?: Record<string, string> } = {},
): Promise<void> {
  const reason = fields.reason ?? ""
  const email = clean(fields.email ?? "", 200)
  // Same client-IP rule as the allowlist gate (Caddy's X-Forwarded-For first hop).
  const ip = clean(clientIpFrom(req.headers) || "unknown", 45)
  const userAgent = clean(req.headers.get("user-agent") ?? "", 160)
  const detail = Object.entries(fields.detail ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(clean(v, 200))}`)
    .join(" ")

  if (FAILED_EVENTS.includes(event)) {
    console.warn(
      `[auth] ${event} reason=${reason}` +
        (email ? ` email=${JSON.stringify(email)}` : "") +
        (detail ? ` ${detail}` : "") +
        ` ip=${ip} ua=${JSON.stringify(userAgent)}`,
    )
  }
  try {
    await prisma.authLog.create({ data: { event, reason, email, ip, userAgent, detail } })
  } catch (err) {
    // The audit trail must never be the reason a sign-in fails.
    console.error("[auth] could not store auth event:", (err as Error).message)
  }
}
