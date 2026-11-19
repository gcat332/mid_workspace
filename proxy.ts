import { NextRequest, NextResponse } from "next/server"
import { decodeJwt } from "jose"
// verifyToken, never a bare jwtVerify: the gate must apply the shape checks in lib/auth/jwt.ts
// (issuer, no `purpose` claim, real userId/email/role, ahAt), not merely confirm a token parses.
import { signToken, verifyToken, SESSION_COOKIE, type SessionPayload } from "@/lib/auth/jwt"
import { sessionCookieOptions } from "@/lib/auth/cookie"
import { AGENTHUB_SESSION_COOKIE, REVERIFY_SECONDS, lookupAgentHubAdmin } from "@/lib/auth/agenthub"
import { auditDenied } from "@/lib/auth/denial-audit"
import { blockedClientIp, ipBlockedResponse } from "@/lib/net/ip-gate"
import { clientIpFrom } from "@/lib/net/ip-allowlist"

// request.nextUrl.pathname excludes basePath ("/midhub"), so these are basePath-relative.
// Neither is ever gated or re-verified, and neither redirects into the gate: no redirect loop is possible.
const ACCESS_PAGE = "/login"
const SIGN_IN_ROUTE = "/api/auth/agenthub"

// This gate checks the JWT and, every REVERIFY_SECONDS, asks AgentHub whether the user is still an AgentHub
// admin. Revocation inside MidHub (lock, deleted user) is enforced by getSessionUser()/require*() in
// lib/auth/helpers.ts, which every API route and page goes through. authAt is carried over so sliding never
// extends a revoked session's validity.

// Re-mint the session cookie so its 4 h idle lifetime slides forward (expiresAt given: keep the old expiry).
async function setSession(res: NextResponse, payload: SessionPayload, expiresAt?: number): Promise<void> {
  const token = await signToken(
    { userId: payload.userId, email: payload.email, role: payload.role, authAt: payload.authAt, ahAt: payload.ahAt },
    { expiresAt },
  )
  const opts = sessionCookieOptions()
  const maxAge = expiresAt === undefined ? opts.maxAge : Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  res.cookies.set(SESSION_COOKIE, token, { ...opts, maxAge })
}

const clearSession = (res: NextResponse): NextResponse => {
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 })
  return res
}

const unauthenticated = (): NextResponse =>
  clearSession(NextResponse.json(
    { code: "unauthenticated", message: "เซสชันหมดอายุหรือยังไม่ได้เข้าสู่ระบบ กรุณาเปิด MidHub ใหม่อีกครั้ง" },
    { status: 401 },
  ))

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The host the browser addressed: the first X-Forwarded-Host value, else Host. Deployed AgentHub (hand-written
 * /midhub proxy route) passes the browser's Host through unchanged and a client X-Forwarded-Host too, so both are
 * the browser's host (or Next fills in a copy of Host); Caddy sends both as the browser's host. Only if AgentHub
 * switched to a real Next rewrite would Host be 127.0.0.1:3100 with X-Forwarded-Host carrying the browser's host,
 * which this also handles. Why trusting the header is safe: a browser cannot add it to a cross-origin request
 * without a CORS preflight, which MidHub never grants.
 */
function browserHost(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-host")?.split(",")[0].trim()
  return (fwd || req.headers.get("host") || req.nextUrl.host).toLowerCase()
}

/**
 * CSRF guard for state-changing API calls (sameSite=lax already keeps the cookie off cross-site POSTs; this
 * also stops same-site-but-other-origin pages). Browsers always send Origin and/or Sec-Fetch-Site on such
 * requests; non-browser clients (curl) send neither and are let through. Scheme is ignored: TLS ends at
 * Caddy or the F5, before MidHub.
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
  return originHost !== browserHost(req)
}

// Build a redirect to an in-app path. basePath is added explicitly (and "/" maps to the bare
// basePath) so the Location never gets a stray trailing slash.
// The browser always gets a RELATIVE Location (/midhub/...): req.url is the URL Next builds from its own listen
// address (never from Host), and Next's proxy adapter rewrites a Location on that same origin to path + query.
// A bare relative Location cannot be returned from here: the adapter parses it with new URL() and throws.
// Both are pinned by proxy.redirects.test.ts, which runs this proxy through Next's real adapter.
function redirectTo(req: NextRequest, path: string): NextResponse {
  const base = req.nextUrl.basePath
  return NextResponse.redirect(new URL(path === "/" ? base || "/" : base + path, req.url))
}

// No (valid) session on a page: sign in through AgentHub, then come back to this path + query (GET only).
function toSignIn(req: NextRequest): NextResponse {
  let target = SIGN_IN_ROUTE
  if (req.method === "GET") {
    const search = new URLSearchParams(req.nextUrl.search)
    search.delete("_rsc") // Next's client-navigation marker, not part of the page address
    const qs = search.toString()
    target += "?" + new URLSearchParams({ next: req.nextUrl.pathname + (qs ? `?${qs}` : "") }).toString()
  }
  return clearSession(redirectTo(req, target))
}

function isPrefetch(req: NextRequest): boolean {
  const h = req.headers
  return h.get("next-router-prefetch") === "1" ||
    (h.get("purpose") ?? "").toLowerCase().includes("prefetch") ||
    (h.get("sec-purpose") ?? "").toLowerCase().includes("prefetch")
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isApi = pathname.startsWith("/api/")

  // 1) IP allowlist (empty = allow all, loopback always allowed), before auth.
  const ip = await blockedClientIp(req.headers)
  if (ip !== null) {
    // Echo the IP the gate checked so a blocked admin knows what to whitelist.
    // text/plain on purpose: X-Forwarded-For is client-supplied.
    const chain = req.headers.get("x-forwarded-for") ?? ""
    if (isApi) return ipBlockedResponse(ip)
    const body = `Access from your network is not allowed.\n\nYour IP as this server sees it: ${ip}` +
      (chain.includes(",") ? `\nX-Forwarded-For: ${chain}` : "") + "\n"
    return new NextResponse(body, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  // 2) CSRF: unsafe API methods must come from this origin (public routes included).
  if (isApi && !SAFE_METHODS.has(req.method) && crossOrigin(req)) {
    return NextResponse.json(
      { code: "csrf", message: "คำขอนี้ไม่ได้มาจากหน้า MidHub เอง จึงถูกปฏิเสธ กรุณาเปิด MidHub แล้วทำรายการใหม่" },
      { status: 403 },
    )
  }

  // 3) The access page and the sign-in route always run (exact match, no loose prefix). The JWT alone cannot
  // tell a revoked user from a live one; the access page asks the DB and sends a live user on to the app.
  if (pathname === ACCESS_PAGE || pathname === SIGN_IN_ROUTE) return NextResponse.next()

  // 4) Auth gate. A token without ahAt (old local login) fails verifyToken. APIs never start a sign-in.
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const payload: SessionPayload | null = token ? await verifyToken(token) : null
  if (!payload) {
    if (isApi) return unauthenticated()
    // A link prefetch must not start a sign-in (lookup, user upsert, auth.login row) for a page nobody opened.
    if (isPrefetch(req)) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } })
    return toSignIn(req)
  }

  // Logout clears the cookie itself; a fresh token here could win the Set-Cookie race and undo it.
  if (pathname === "/api/auth/logout") return NextResponse.next()
  // Background polls (X-Background: 1) are not user activity: they must not keep an idle session alive.
  const background = req.headers.get("x-background") === "1"

  // 5) Re-verify with AgentHub once ahAt is older than REVERIFY_SECONDS (fail closed: AgentHub down = no access).
  const now = Math.floor(Date.now() / 1000)
  if (now - payload.ahAt > REVERIFY_SECONDS) {
    const lookup = await lookupAgentHubAdmin(req.cookies.get(AGENTHUB_SESSION_COOKIE)?.value)
    if (!lookup.ok) {
      await auditDenied(lookup.reason, { email: payload.email, ip: clientIpFrom(req.headers) || "unknown" })
      return isApi ? unauthenticated() : clearSession(redirectTo(req, `${ACCESS_PAGE}?reason=${lookup.reason}`))
    }
    // AgentHub is now signed in as someone else: this session is not theirs. Pages sign in afresh.
    if (lookup.email !== payload.email.toLowerCase()) return isApi ? unauthenticated() : toSignIn(req)
    const res = NextResponse.next()
    await setSession(res, { ...payload, ahAt: now }, background ? decodeJwt(token!).exp : undefined)
    return res
  }

  const res = NextResponse.next()
  if (background) return res
  await setSession(res, payload)
  return res
}

export const config = {
  // Skip the gate for Next internals and public static assets (logos, icons, fonts), and for /api/agent/*:
  // server-to-server (AgentHub over loopback, no cookie, no browser), it authenticates itself and applies the
  // IP allowlist in lib/agent/auth.ts. Excluded here because Next clones and fully buffers the body of every
  // non-GET request the proxy matches (up to proxyClientMaxBodySize) before the route runs, which would defeat
  // the streamed agent upload and its early 413.
  // Any path ending in one of those extensions also skips the gate (no re-verify, no CSRF check): today only dynamic
  // [id]/[name] API segments could end that way, with no real resource behind them. Never rely on the proxy there.
  // "/" first: with a basePath, Next's compiled pattern for the second entry needs a "/" after "/midhub", so the
  // bare app root "/midhub" (the main entry, where AgentHub sign-in starts) would otherwise skip the proxy.
  matcher: ["/", "/((?!_next/static|_next/image|api/agent/|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$).*)"],
}
