import { NextRequest, NextResponse } from "next/server"
// verifyToken, never a bare jwtVerify: the gate must apply the shape checks in lib/auth/jwt.ts
// (issuer, no `purpose` claim, real userId/email/role), not merely confirm a token parses.
import { signToken, verifyToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth/jwt"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { validLoginNext, LOGIN_NEXT_COOKIE } from "@/lib/auth/login-next"
import { isAllowed, clientIpFrom } from "@/lib/net/ip-allowlist"

// request.nextUrl.pathname excludes basePath ("/midhub"), so these are basePath-relative.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/idp", "/api/auth/oidc/start", "/api/auth/oidc/callback"])

// Re-mint the session cookie so its 4 h idle lifetime slides forward on every authenticated request.
async function slideSession(res: NextResponse, payload: SessionPayload): Promise<void> {
  const token = await signToken({ userId: payload.userId, email: payload.email, role: payload.role })
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
}

// Build a redirect to an in-app path. basePath is added explicitly (and "/" maps to the bare
// basePath) so the Location never gets a stray trailing slash.
function redirectTo(req: NextRequest, path: string): NextResponse {
  const base = req.nextUrl.basePath
  return NextResponse.redirect(new URL(path === "/" ? base || "/" : base + path, req.url))
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // 1) IP allowlist (empty = allow all, loopback always allowed), before auth.
  const ip = clientIpFrom(req.headers)
  if (!(await isAllowed(ip))) {
    // Echo the IP the gate checked so a blocked admin knows what to whitelist.
    // text/plain on purpose: X-Forwarded-For is client-supplied.
    const chain = req.headers.get("x-forwarded-for") ?? ""
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Forbidden", ip }, { status: 403 })
    const body = `Access from your network is not allowed.\n\nYour IP as this server sees it: ${ip}` +
      (chain.includes(",") ? `\nX-Forwarded-For: ${chain}` : "") + "\n"
    return new NextResponse(body, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value
  const payload: SessionPayload | null = token ? await verifyToken(token) : null

  // 2) /login: an already-signed-in user goes to the app; otherwise show the form.
  if (pathname === "/login") {
    return payload ? redirectTo(req, "/") : NextResponse.next()
  }

  // 3) Other public paths (exact match, no loose prefix).
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  // 4) Auth gate.
  if (!payload) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const res = redirectTo(req, "/login")
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 })
    // Preserve a safe deep link across the login round-trip (validLoginNext needs the /midhub prefix).
    const next = validLoginNext(req.nextUrl.basePath + pathname + req.nextUrl.search)
    if (req.method === "GET" && next) {
      res.cookies.set(LOGIN_NEXT_COOKIE, next, { ...sessionCookieOptions(), maxAge: 600 })
    }
    return res
  }
  const res = NextResponse.next()
  // Logout clears the cookie itself; a fresh token here could win the Set-Cookie race and undo it.
  if (pathname === "/api/auth/logout") return res
  await slideSession(res, payload)
  return res
}

export const config = {
  // Skip the gate for Next internals and public static assets (logos, icons, fonts).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$).*)"],
}
