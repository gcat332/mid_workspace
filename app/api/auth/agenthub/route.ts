import { NextResponse, type NextRequest } from "next/server"
import { AGENTHUB_SESSION_COOKIE, lookupAgentHubAdmin, signInFromAgentHub } from "@/lib/auth/agenthub"
import { auditDenied, type DenialReason } from "@/lib/auth/denial-audit"
import { signToken, SESSION_COOKIE } from "@/lib/auth/jwt"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { validLoginNext } from "@/lib/auth/login-next"
import { recordAudit } from "@/lib/audit"
import { MidError } from "@/lib/mids/names"
import { clientIpFrom } from "@/lib/net/ip-allowlist"
import { BASE_PATH } from "@/lib/ui/api"

export const dynamic = "force-dynamic"

// The one way into MidHub: the proxy sends a page request without a valid session here (?next=<path+query>,
// basePath-relative). This route never redirects back into the gate on failure, only to the access page, which
// the proxy never gates: no loop. Locations are relative, so the browser's own origin is kept behind Caddy.
const see = (location: string) => new NextResponse(null, { status: 303, headers: { location } })

/**
 * `next` (basePath-relative path + query) → an ASCII Location inside the app, or the app root on any doubt.
 * Percent-decoded once to find dot segments (`..`, `%2e%2e`), control characters and backslashes; characters
 * outside printable ASCII are percent-encoded (a Location header must be a ByteString); existing escapes are kept.
 */
function nextLocation(raw: string | null): string {
  if (!raw || raw === "/" || !raw.startsWith("/") || raw.startsWith("//")) return BASE_PATH
  try {
    const decoded = decodeURIComponent(raw)
    if (/[\x00-\x1f\x7f\\]/.test(decoded)) return BASE_PATH
    if (decoded.split(/[?#]/)[0].split("/").some((seg) => seg === "." || seg === "..")) return BASE_PATH
    const loc = BASE_PATH + raw.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c))
    const resolved = new URL(loc, "http://x").pathname
    if (resolved !== BASE_PATH && !resolved.startsWith(`${BASE_PATH}/`)) return BASE_PATH
    return validLoginNext(loc) ?? BASE_PATH
  } catch {
    return BASE_PATH // malformed escape or lone surrogate
  }
}

function toAccessPage(reason: DenialReason): NextResponse {
  const res = see(`${BASE_PATH}/login?reason=${reason}`)
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 })
  return res
}

export async function GET(req: NextRequest) {
  const ip = clientIpFrom(req.headers) || "unknown"
  const lookup = await lookupAgentHubAdmin(req.cookies.get(AGENTHUB_SESSION_COOKIE)?.value)
  if (!lookup.ok) {
    await auditDenied(lookup.reason, { ip })
    return toAccessPage(lookup.reason)
  }
  let session
  try {
    session = await signInFromAgentHub(lookup.email)
  } catch (e) {
    if (!(e instanceof MidError && e.code === "account_locked")) throw e
    await auditDenied("locked", { email: lookup.email, ip })
    return toAccessPage("locked")
  }
  const res = see(nextLocation(req.nextUrl.searchParams.get("next")))
  res.cookies.set(SESSION_COOKIE, await signToken(session), sessionCookieOptions())
  await recordAudit(session, "auth.login", undefined, { via: "agenthub" })
  return res
}
