import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { idpService } from "@/lib/services/idp"
import { prisma } from "@/lib/db/client"
import { discover, verifyIdToken, emailFromClaims, findRegisteredUser, publicBase, OIDC_TEMP_COOKIES } from "@/lib/auth/oidc"
import { signToken, SESSION_COOKIE } from "@/lib/auth/session"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { validLoginNext, LOGIN_NEXT_COOKIE } from "@/lib/auth/login-next"
import { recordAuthEvent } from "@/lib/auth/auth-log"

// SSO callback: validate state, exchange the code, verify the id_token, then sign in ONLY a
// user already registered in MidHub. The redirect carries a short error code (never free text);
// the login page maps codes to Thai messages. Details go to the auth log.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const base = publicBase(req)
  const fail = async (code: string, reason: string, detail: Record<string, string> = {}, email = "") => {
    await recordAuthEvent("sso_failed", req, { reason, email, detail })
    const u = new URL("/midhub/login", base)
    u.searchParams.set("error", code)
    const res = NextResponse.redirect(u)
    for (const n of OIDC_TEMP_COOKIES) res.cookies.set(n, "", { path: "/midhub", maxAge: 0 })
    return res
  }

  const idpError = url.searchParams.get("error")
  if (idpError) {
    return fail("idp", "idp_error", { error: idpError, description: url.searchParams.get("error_description") ?? "" })
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const jar = await cookies()
  if (!code || !state || state !== jar.get("oidc_state")?.value) return fail("state", "bad_state")

  const c = await idpService.get()
  if (!c || !c.enabled) return fail("disabled", "sso_disabled")

  try {
    const disc = await discover(c.issuer)
    const redirectUri = jar.get("oidc_redirect")?.value || c.redirectUri
    const tokenRes = await fetch(disc.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code_verifier: jar.get("oidc_verifier")?.value ?? "",
      }),
    })
    if (!tokenRes.ok) return fail("token", "token_exchange", { status: String(tokenRes.status) })
    const tok = (await tokenRes.json()) as { id_token?: string }
    if (!tok.id_token) return fail("token", "no_id_token")

    const claims = await verifyIdToken(tok.id_token, disc.jwks_uri, disc.issuer, c.clientId)
    const expectedNonce = jar.get("oidc_nonce")?.value
    // Fail closed: a missing nonce cookie must not skip the check.
    if (!expectedNonce || claims.nonce !== expectedNonce) return fail("state", "nonce_mismatch")

    const email = emailFromClaims(claims)
    if (!email) return fail("no_email", "no_email")

    const user = await findRegisteredUser(email)
    if (!user) return fail("not_registered", "not_registered", {}, email)
    if (user.lockedAt) return fail("locked", "locked", {}, email)

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0 } })
    await recordAuthEvent("sso_ok", req, { email: user.email })
    const role = user.role === "admin" ? "admin" : "member"
    const token = await signToken({ userId: user.id, email: user.email, role })
    const next = validLoginNext(jar.get(LOGIN_NEXT_COOKIE)?.value) ?? "/midhub"
    const res = NextResponse.redirect(new URL(next, base))
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    for (const n of OIDC_TEMP_COOKIES) res.cookies.set(n, "", { path: "/midhub", maxAge: 0 })
    res.cookies.set(LOGIN_NEXT_COOKIE, "", { path: "/midhub", maxAge: 0 })
    return res
  } catch (e) {
    return fail("failed", "exception", { message: (e as Error).message })
  }
}
