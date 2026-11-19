// Sign-in through BSM AgentHub (spec 2026-11-19): only AgentHub admins may use MidHub. MidHub never verifies
// AgentHub's JWT or holds its secret; it asks AgentHub over loopback who the browser's `session` cookie belongs to.
// The cookie value is a credential: it is sent only to env.agenthubUrl and never logged, audited or returned.
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { isLocked } from "@/lib/auth/lockout"
import { MidError } from "@/lib/mids/names"
import type { SessionPayload } from "@/lib/auth/jwt"

/** AgentHub's session cookie (httpOnly, Path=/), sent by the browser with /midhub requests on the same site. */
export const AGENTHUB_SESSION_COOKIE = "session"
/** A MidHub session is re-checked with AgentHub once its ahAt is older than this. */
export const REVERIFY_SECONDS = 300
const TIMEOUT_MS = 5000

export type AgentHubDenial = "signed_out" | "not_admin" | "unreachable"
export type AgentHubLookup = { ok: true; email: string } | { ok: false; reason: AgentHubDenial }

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/
// RFC 6265 cookie-octets (no CTLs, whitespace, DQUOTE, comma, semicolon, backslash): anything else could not have
// come from AgentHub and must not be pasted into a header.
const COOKIE_VALUE_RE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/

const deny = (reason: AgentHubDenial): AgentHubLookup => ({ ok: false, reason })

/**
 * Asks AgentHub (GET <AGENTHUB_URL>/api/auth/me, only `Cookie: session=<value>`, redirects not followed, 5 s
 * timeout) whether the cookie belongs to an AgentHub admin. 200 admin with an email -> ok; 200 other role ->
 * not_admin; 401/403 or no cookie -> signed_out; anything else (5xx, redirect, bad body, network, timeout) -> unreachable.
 */
export async function lookupAgentHubAdmin(sessionCookie: string | undefined): Promise<AgentHubLookup> {
  if (!sessionCookie || !COOKIE_VALUE_RE.test(sessionCookie)) return deny("signed_out")
  let res: Response
  try {
    res = await fetch(`${env.agenthubUrl}/api/auth/me`, {
      method: "GET",
      headers: { cookie: `${AGENTHUB_SESSION_COOKIE}=${sessionCookie}` },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return deny("unreachable")
  }
  if (res.status === 401 || res.status === 403) return deny("signed_out")
  if (res.status !== 200) return deny("unreachable")
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return deny("unreachable")
  }
  const { email, role } = (typeof body === "object" && body !== null ? body : {}) as { email?: unknown; role?: unknown }
  if (role !== "admin") return typeof role === "string" ? deny("not_admin") : deny("unreachable")
  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) return deny("unreachable")
  return { ok: true, email: email.toLowerCase() }
}

/**
 * Turns a confirmed AgentHub admin into a MidHub session: upserts the user as admin (records last sign-in) and
 * returns the payload to sign. A MidHub lock still wins over AgentHub: throws MidError("account_locked").
 */
export async function signInFromAgentHub(email: string): Promise<SessionPayload> {
  const addr = email.toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email: addr }, select: { lockedAt: true } })
  if (existing && isLocked(existing.lockedAt)) throw new MidError("account_locked")
  const now = new Date()
  const user = await prisma.user.upsert({
    where: { email: addr },
    update: { role: "admin", lastLoginAt: now },
    // passwordHash is NOT NULL in the schema; "" never matches anything and there is no password login anyway.
    create: { email: addr, role: "admin", passwordHash: "", lastLoginAt: now },
    select: { id: true, email: true },
  })
  const at = Math.floor(now.getTime() / 1000)
  return { userId: user.id, email: user.email, role: "admin", authAt: at, ahAt: at }
}
