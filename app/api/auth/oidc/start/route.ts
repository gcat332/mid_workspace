import { NextResponse } from "next/server"
import { idpService } from "@/lib/services/idp"
import { discover, randomString, pkceChallenge, publicBase } from "@/lib/auth/oidc"

// SSO entrypoint: OIDC authorization-code redirect with PKCE + state + nonce in short-lived cookies.
export async function GET(req: Request) {
  const base = publicBase(req)
  const loginErr = (code: string) => {
    const u = new URL("/midhub/login", base)
    u.searchParams.set("error", code)
    return NextResponse.redirect(u)
  }

  const c = await idpService.get()
  if (!c || !c.enabled) return loginErr("disabled")
  if (!c.issuer || !c.clientId) return loginErr("misconfigured")

  try {
    const disc = await discover(c.issuer)
    const redirectUri = c.redirectUri || new URL("/midhub/api/auth/oidc/callback", base).toString()

    const state = randomString()
    const nonce = randomString()
    const verifier = randomString(48)
    const challenge = await pkceChallenge(verifier)

    const auth = new URL(disc.authorization_endpoint)
    auth.searchParams.set("client_id", c.clientId)
    auth.searchParams.set("response_type", "code")
    auth.searchParams.set("redirect_uri", redirectUri)
    auth.searchParams.set("scope", c.scopes || "openid profile email")
    auth.searchParams.set("state", state)
    auth.searchParams.set("nonce", nonce)
    auth.searchParams.set("code_challenge", challenge)
    auth.searchParams.set("code_challenge_method", "S256")
    auth.searchParams.set("response_mode", "query")

    const res = NextResponse.redirect(auth)
    const opts = { httpOnly: true as const, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/midhub" }
    res.cookies.set("oidc_state", state, opts)
    res.cookies.set("oidc_nonce", nonce, opts)
    res.cookies.set("oidc_verifier", verifier, opts)
    res.cookies.set("oidc_redirect", redirectUri, opts)
    return res
  } catch (e) {
    console.warn("[auth] sso start failed:", (e as Error).message)
    return loginErr("start")
  }
}
