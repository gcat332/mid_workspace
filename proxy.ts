import { NextRequest, NextResponse } from "next/server"
// verifyToken, never a bare jwtVerify: the gate must apply the shape checks in lib/auth/jwt.ts
// (issuer, no `purpose` claim, real userId/email/role), not merely confirm a token parses.
import { signToken, verifyToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth/jwt"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { validLoginNext, LOGIN_NEXT_COOKIE } from "@/lib/auth/login-next"
import { isAllowed, clientIpFrom } from "@/lib/net/ip-allowlist"

// request.nextUrl.pathname excludes basePath ("/midhub"), so these are basePath-relative.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/idp", "/api/auth/oidc/start", "/api/auth/oidc/callback"])

// This gate is JWT-only (it runs on the edge, no DB). Revocation (deleted/locked/demoted user, password
// reset) is enforced by getSessionUser()/require*() in lib/auth/helpers.ts, which every API route and
// admin page goes through. authAt is carried over so sliding never extends a revoked session's validity.
// Re-mint the session cookie so its 4 h idle lifetime slides forward on every authenticated request.
async function slideSession(res: NextResponse, payload: SessionPayload): Promise<void> {
  const token = await signToken({ userId: payload.userId, email: payload.email, role: payload.role, authAt: payload.authAt })
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * CSRF guard for state-changing API calls (sameSite=lax already keeps the cookie off cross-site POSTs; this
 * also stops same-site-but-other-origin pages). Browsers always send Origin and/or Sec-Fetch-Site on such
 * requests; non-browser clients (curl) send neither and are let through. Scheme is ignored: TLS ends at Caddy.
 */
function crossOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") return true
  const origin = req.headers.get("origin")
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true // "null" or garbage
  }
  return originHost !== (req.headers.get("host") ?? req.nextUrl.host)
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
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ code: "ip_blocked", message: `IP ของคุณ (${ip}) ไม่อยู่ใน IP Allowlist กรุณาให้ Admin เพิ่ม IP นี้`, ip }, { status: 403 })
    }
    const body = `Access from your network is not allowed.\n\nYour IP as this server sees it: ${ip}` +
      (chain.includes(",") ? `\nX-Forwarded-For: ${chain}` : "") + "\n"
    return new NextResponse(body, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  // 2) CSRF: unsafe API methods must come from this origin (public login included).
  if (pathname.startsWith("/api/") && !SAFE_METHODS.has(req.method) && crossOrigin(req)) {
    return NextResponse.json(
      { code: "csrf", message: "คำขอนี้ไม่ได้มาจากหน้า MidHub เอง จึงถูกปฏิเสธ กรุณาเปิด MidHub แล้วทำรายการใหม่" },
      { status: 403 },
    )
  }

  // 3) /login always renders. The JWT alone cannot tell a revoked user (locked/deleted/password reset) from a
  // live one; the page asks the DB and sends a live user on to the app. Bouncing here caused a redirect loop.
  if (pathname === "/login") return NextResponse.next()

  const token = req.cookies.get(SESSION_COOKIE)?.value
  const payload: SessionPayload | null = token ? await verifyToken(token) : null

  // 4) Other public paths (exact match, no loose prefix).
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  // 5) Auth gate.
  if (!payload) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ code: "unauthorized", message: "เซสชันหมดอายุหรือยังไม่ได้เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่" }, { status: 401 })
    }
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
  // Background polls (X-Background: 1) are not user activity: they must not keep an idle session alive.
  if (req.headers.get("x-background") === "1") return res
  await slideSession(res, payload)
  return res
}

export const config = {
  // Skip the gate for Next internals and public static assets (logos, icons, fonts).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$).*)"],
}
