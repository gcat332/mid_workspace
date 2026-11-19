import { createHash, timingSafeEqual } from "node:crypto"
import { env } from "@/lib/env"
import { isValidEmail, signInFromAgentHub } from "@/lib/auth/agenthub"
import type { SessionPayload } from "@/lib/auth/jwt"
import { normalizeInstanceUrl } from "@/lib/instances/url"
import { blockedClientIp, ipBlockedResponse } from "@/lib/net/ip-gate"
import { recordAudit } from "@/lib/audit"
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

function isLoopbackHost(raw: string | null): boolean {
  if (raw === null) return false
  const h = raw.trim().toLowerCase()
  const m = /^(?:\[::1\]|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)(?::\d{1,5})?$/.exec(h)
  if (!m) return false
  const ip = /^127\.(\d+)\.(\d+)\.(\d+)/.exec(h)
  return !ip || [ip[1], ip[2], ip[3]].every((o) => Number(o) <= 255)
}

/**
 * "The call came straight over loopback, not through Caddy or AgentHub's /midhub rewrite." Defense in depth;
 * the primary guards are the 404 for /midhub/api/agent/* in Caddy and in AgentHub's rewrite (plus the secret).
 *
 * 1) Forwarding headers. Verified empirically (Next 16.4.6): Next itself injects `x-forwarded-for` from the
 *    socket address when the incoming request has none ("::ffff:127.0.0.1" / "::1") and keeps a
 *    client-supplied value, so mere presence cannot be the test. Every XFF entry must be loopback.
 *    `X-Real-IP` and `Forwarded for=` get the same treatment. XFF alone is spoofable: Caddy derives the
 *    client address from a client-supplied XFF when the hop is a trusted proxy, so it does not always
 *    carry the real client address.
 * 2) Host. Caddy passes the client's original Host through (an IP or dev-agenthub.mfec.co.th) and only
 *    routes matching sites, while AgentHub calls http://127.0.0.1:3100/midhub. So Host must be a loopback
 *    authority (127.x / [::1] / localhost, any port).
 * 3) X-Forwarded-Host. AgentHub's Next rewrite (/midhub/:path* -> http://127.0.0.1:3100/midhub/:path*,
 *    changeOrigin) makes Host loopback, and XFF loopback too when the client sent none, so Host alone would let
 *    a browser request through if AgentHub's 404 for /midhub/api/agent/* were missing or bypassed. The rewrite
 *    always sets X-Forwarded-Host to the browser's host (Caddy sets it too); AgentHub's own fetch never does.
 *    Mere presence cannot be the test either: verified on next dev 16.4.6, Next injects
 *    `x-forwarded-host = Host` into every request that has none (base-server.js), so a direct call arrives with
 *    it. Rule: if present, it must equal Host exactly (case-insensitive), which only that injected copy does.
 */
export function cameDirectlyOverLoopback(h: Headers): boolean {
  const host = h.get("host")
  if (!isLoopbackHost(host)) return false
  const xfh = h.get("x-forwarded-host")
  if (xfh !== null && xfh.trim().toLowerCase() !== host!.trim().toLowerCase()) return false
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
 * IP allowlist -> 403 ip_blocked, loopback-only -> 403, then the actor: AgentHub must vouch for an admin via X-MidHub-Actor-Role, and the user is upserted as admin (locked -> 403). Checked on every request, never cached.
 * The secret value is never logged or put into any error.
 */
export async function authenticateAgent(req: Request): Promise<AgentCaller> {
  const secret = env.agentSecret
  if (!secret) throw new MidError("not_found", 404, "ไม่พบเส้นทางที่ระบุ")

  const given = req.headers.get("x-midhub-agent-secret")
  if (given === null || !secretMatches(given, secret)) throw new MidError("agent_auth")
  // The proxy matcher skips /api/agent/* (body buffering), so the IP allowlist is applied here instead.
  const blocked = await blockedClientIp(req.headers)
  if (blocked !== null) throw ipBlockedResponse(blocked)
  if (!cameDirectlyOverLoopback(req.headers)) {
    throw new MidError("agent_auth", 403, "MidHub รับคำขอ AgentHub เฉพาะที่เรียกตรงผ่าน loopback เท่านั้น ไม่รับผ่าน Caddy/proxy")
  }

  const taskId = (req.headers.get("x-midhub-session-id") ?? "").trim()
  if (!taskId || taskId.length > 128 || /[^\x21-\x7e]/.test(taskId)) {
    throw new MidError("agent_auth", 400, "AgentHub ส่ง X-MidHub-Session-Id ไม่ถูกต้อง ตรวจการตั้งค่าฝั่ง AgentHub")
  }

  const email = (req.headers.get("x-midhub-actor-email") ?? "").trim().toLowerCase()
  // AgentHub sends the actor's role read from its own DB on this request (never from the JWT). Only exactly "admin" passes.
  if (!email || req.headers.get("x-midhub-actor-role") !== "admin") {
    throw new MidError("agent_user", 403, `ต้องเป็น admin ของ AgentHub (บัญชี ${email.slice(0, 80) || "(ไม่ระบุ)"})`)
  }
  if (!isValidEmail(email)) {
    throw new MidError("agent_user", 403, "อีเมลผู้ใช้ที่ AgentHub ส่งมา (X-MidHub-Actor-Email) ไม่ถูกต้อง ตรวจการตั้งค่าฝั่ง AgentHub")
  }
  let user: SessionPayload
  try {
    // Upserts the admin (a first-time actor has never opened MidHub); no session, cookie or auth.login audit row.
    user = await signInFromAgentHub(email, {
      recordLogin: false,
      // Only a brand-new account is audited (traceability); calls for existing users write nothing.
      onCreated: (u) => recordAudit({ userId: u.userId, email: u.email, role: "admin", ahAt: Math.floor(Date.now() / 1000) }, "user.created", undefined, { via: "agenthub", email: u.email }),
    })
  } catch (e) {
    if (e instanceof MidError && e.code === "account_locked") {
      throw new MidError("agent_user", 403, `บัญชี ${email} ถูกล็อกใน MidHub ให้ Admin ปลดล็อกที่หน้า Admin > ผู้ใช้`)
    }
    throw e
  }
  return {
    // ahAt: AgentHub vouches for the actor on this very request (server-to-server, no MidHub session involved).
    user: { userId: user.userId, email: user.email, role: "admin", ahAt: user.ahAt },
    taskId,
    sessionInstances: parseSessionInstances(req.headers.get("x-midhub-session-instances")),
  }
}
