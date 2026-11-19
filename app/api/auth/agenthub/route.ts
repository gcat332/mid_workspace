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

/** `next` must be an in-app path ("/..." but not "//..."); anything else, or "/", goes to the app root. */
function nextLocation(raw: string | null): string {
  if (!raw || raw === "/" || !raw.startsWith("/") || raw.startsWith("//")) return BASE_PATH
  return validLoginNext(BASE_PATH + raw) ?? BASE_PATH
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
