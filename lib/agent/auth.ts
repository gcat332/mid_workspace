import { createHash, timingSafeEqual } from "node:crypto"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { isLocked } from "@/lib/auth/lockout"
import type { SessionPayload } from "@/lib/auth/jwt"
import { normalizeInstanceUrl } from "@/lib/instances/url"
import { MidError } from "@/lib/mids/names"

export type AgentCaller = { user: SessionPayload; taskId: string; sessionInstances: string[] }

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest()

/** Constant-time compare; both sides are hashed first so the buffers always have equal length. */
function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected))
}

function isLoopbackAddr(raw: string): boolean {
  let v = raw.trim().toLowerCase()
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") === -1 ? undefined : v.indexOf("]")) // [::1]:80
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":")) // 127.0.0.1:80
  if (v === "::1") return true
  if (v.startsWith("::ffff:")) v = v.slice(7)
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v)
  return !!m && [m[1], m[2], m[3]].every((o) => Number(o) <= 255)
}

/**
 * "The call came straight over loopback, not through Caddy."
 *
 * Verified empirically (Next 16.4.6 dev server): Next itself injects `x-forwarded-for` from the socket
 * address when the incoming request has none ("::ffff:127.0.0.1" for 127.0.0.1, "::1" for ::1/localhost)
 * and leaves a client-supplied value untouched. So the header is always present inside the app and its mere
 * presence cannot be the test. Caddy always sets the real client address, so: every X-Forwarded-For entry
 * must be a loopback address. (Known limit: someone browsing on this host through Caddy also looks local;
 * Caddy's own 404 block for /midhub/api/agent/* is the second layer.) `X-Real-IP` and `Forwarded for=` get
 * the same treatment as cheap defence in case Caddy is configured to send them.
 */
export function cameDirectlyOverLoopback(h: Headers): boolean {
  const xff = h.get("x-forwarded-for")
  if (xff !== null && !xff.split(",").every(isLoopbackAddr)) return false
  const real = h.get("x-real-ip")
  if (real !== null && !isLoopbackAddr(real)) return false
  const fwd = h.get("forwarded")
  if (fwd !== null) {
    for (const el of fwd.split(",")) {
      for (const part of el.split(";")) {
        const m = /^\s*for\s*=\s*(.*?)\s*$/i.exec(part)
        if (m && !isLoopbackAddr(m[1])) return false
      }
    }
  }
  return true
}

/** Comma-separated instance URLs -> normalised, deduped, invalid dropped. */
export function parseSessionInstances(raw: string | null): string[] {
  const out = new Set<string>()
  for (const part of (raw ?? "").split(",")) {
    try { out.add(normalizeInstanceUrl(part)) } catch { /* drop */ }
  }
  return [...out]
}

/**
 * Authenticates an AgentHub -> MidHub call (spec 5, 5.1). Order: feature off -> 404, secret -> 401,
 * loopback-only -> 403, then the actor from the DB (checked on every request, never cached).
 * The secret value is never logged or put into any error.
 */
export async function authenticateAgent(req: Request): Promise<AgentCaller> {
  const secret = env.agentSecret
  if (!secret) throw new MidError("not_found", 404, "ไม่พบเส้นทางที่ระบุ")

  const given = req.headers.get("x-midhub-agent-secret")
  if (given === null || !secretMatches(given, secret)) throw new MidError("agent_auth")
  if (!cameDirectlyOverLoopback(req.headers)) {
    throw new MidError("agent_auth", 403, "MidHub รับคำขอ AgentHub เฉพาะที่เรียกตรงผ่าน loopback เท่านั้น ไม่รับผ่าน Caddy/proxy")
  }

  const taskId = (req.headers.get("x-midhub-session-id") ?? "").trim()
  if (!taskId || taskId.length > 128 || /[^\x21-\x7e]/.test(taskId)) {
    throw new MidError("agent_auth", 400, "AgentHub ส่ง X-MidHub-Session-Id ไม่ถูกต้อง ตรวจการตั้งค่าฝั่ง AgentHub")
  }

  const email = (req.headers.get("x-midhub-actor-email") ?? "").trim().toLowerCase()
  const user = email && email.length <= 254
    ? await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, role: true, lockedAt: true } })
    : null
  if (!user || isLocked(user.lockedAt)) {
    throw new MidError("agent_user", 403, `ผู้ใช้ ${email.slice(0, 254) || "(ไม่ระบุ)"} ยังไม่มีสิทธิ์ใช้ MidHub ให้ Admin เพิ่มในหน้า Users`)
  }
  return {
    user: { userId: user.id, email: user.email, role: user.role === "admin" ? "admin" : "member" },
    taskId,
    sessionInstances: parseSessionInstances(req.headers.get("x-midhub-session-instances")),
  }
}
