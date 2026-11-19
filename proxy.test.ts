import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest"
import { NextRequest } from "next/server"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { signToken, verifyToken } from "@/lib/auth/jwt"

let cidrs: string[] = []
vi.mock("@/lib/db/client", () => ({
  prisma: { ipAllowlist: { findMany: vi.fn(async () => cidrs.map((cidr) => ({ cidr }))) } },
}))
const auditDenied = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/auth/denial-audit", () => ({ auditDenied }))

// Fake AgentHub (/api/auth/me) on a random loopback port; `ah` is what it answers, `ahCalls` counts lookups.
let ah: { status: number; body: string } = { status: 200, body: '{"email":"a@x.com","role":"admin"}' }
let ahCalls = 0
let ahCookies: (string | undefined)[] = []
const fakeAgentHub = http.createServer((q, r) => {
  ahCalls++
  ahCookies.push(q.headers.cookie)
  r.writeHead(ah.status, { "content-type": "application/json" })
  r.end(ah.body)
})
let ahBase = "http://127.0.0.1:1"
vi.mock("@/lib/env", () => ({ env: { get agenthubUrl() { return ahBase } } }))
beforeAll(async () => {
  await new Promise<void>((r) => fakeAgentHub.listen(0, "127.0.0.1", r))
  ahBase = `http://127.0.0.1:${(fakeAgentHub.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => fakeAgentHub.close(() => r())))

import { config, proxy } from "@/proxy"
// Next's own matcher compiler and runtime matcher (internal modules of the pinned next@16.4.6).
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info"
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher"
// Exported at runtime but not in the .d.ts.
const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (m: string[], cfg: { basePath: string }) => Parameters<typeof getMiddlewareRouteMatcher>[0]
}

// Real Next strips basePath from request.nextUrl.pathname in the proxy; NextRequest only does the
// same when told the basePath via nextConfig. Passing it makes these tests behave like production.
const req = (path: string, init: { headers?: Record<string, string>; method?: string } = {}) =>
  new NextRequest(`http://localhost:3100/midhub${path}`, {
    ...init,
    nextConfig: { basePath: "/midhub" },
  } as ConstructorParameters<typeof NextRequest>[1])

const nowS = () => Math.floor(Date.now() / 1000)
const token = (ahAgo = 0) => signToken({ userId: "u1", email: "a@x.com", role: "admin", ahAt: nowS() - ahAgo })
const withCookie = async (name: string, headers: Record<string, string> = {}) => ({
  ...headers,
  cookie: `${name}=${await token()}`,
})
// A MidHub session last confirmed by AgentHub `ahAgo` seconds ago, plus the browser's AgentHub cookie.
const stale = async (ahAgo: number, headers: Record<string, string> = {}) => ({
  ...headers,
  cookie: `midhub_session=${await token(ahAgo)}; session=ah-cookie`,
})
const setCookie = (res: Response) => res.headers.get("set-cookie") ?? ""
const newSession = (res: Response) => /midhub_session=([^;]*)/.exec(setCookie(res))?.[1]
const location = (res: Response) => {
  const l = res.headers.get("location")
  return l ? new URL(l, "http://localhost:3100") : null
}

beforeEach(() => {
  cidrs = []
  ah = { status: 200, body: '{"email":"a@x.com","role":"admin"}' }
  ahCalls = 0
  ahCookies = []
  auditDenied.mockClear()
})

describe("IP allowlist", () => {
  it("passes an allowed first hop (10.1.2.3 in 10.0.0.0/8)", async () => {
    cidrs = ["10.0.0.0/8"]
    const res = await proxy(req("/", { headers: await withCookie("midhub_session", { "x-forwarded-for": "10.1.2.3, 1.1.1.1" }) }))
    expect(res.status).toBe(200)
  })

  it("403s a disallowed IP even with a valid cookie", async () => {
    cidrs = ["10.0.0.0/8"]
    const res = await proxy(req("/", { headers: await withCookie("midhub_session", { "x-forwarded-for": "8.8.8.8" }) }))
    expect(res.status).toBe(403)
    expect(res.headers.get("content-type")).toContain("text/plain")
  })

  it("403s an API call as JSON with the checked ip", async () => {
    cidrs = ["10.0.0.0/8"]
    const res = await proxy(req("/api/mids", { headers: { "x-forwarded-for": "8.8.8.8" } }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "ip_blocked", ip: "8.8.8.8" })
  })

  it("empty allowlist allows everyone", async () => {
    const res = await proxy(req("/", { headers: await withCookie("midhub_session", { "x-forwarded-for": "8.8.8.8" }) }))
    expect(res.status).toBe(200)
  })

  it("enforces IPv6 entries", async () => {
    cidrs = ["2001:db8::/32"]
    const ok = await proxy(req("/api/x", { headers: { "x-forwarded-for": "2001:db8::1" } }))
    expect(ok.status).toBe(401) // allowed through the IP gate, then stopped by auth
    const blocked = await proxy(req("/api/x", { headers: { "x-forwarded-for": "2001:db9::1" } }))
    expect(blocked.status).toBe(403)
  })
})

describe("auth gate", () => {
  it("a page without a session goes to the AgentHub sign-in route with next = original path + query", async () => {
    const res = await proxy(req("/mids?x=1"))
    expect(res.status).toBe(307)
    const l = location(res)!
    expect(l.pathname).toBe("/midhub/api/auth/agenthub")
    expect(l.searchParams.get("next")).toBe("/mids?x=1")
    expect(ahCalls).toBe(0) // the proxy itself does not look up; the sign-in route does
  })

  it("/midhub/ without a session -> sign-in route with next=/", async () => {
    const res = await proxy(req("/"))
    expect(location(res)!.pathname).toBe("/midhub/api/auth/agenthub")
    expect(location(res)!.searchParams.get("next")).toBe("/")
  })

  it("Next's RSC marker is not carried into next", async () => {
    const res = await proxy(req("/mids?_rsc=abc&x=1"))
    expect(location(res)!.searchParams.get("next")).toBe("/mids?x=1")
  })

  it("401 {code:'unauthenticated'} for an API call without a session; no sign-in attempt", async () => {
    const res = await proxy(req("/api/mids", { headers: { cookie: "session=ah-cookie" } }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "unauthenticated" })
    expect(res.headers.get("location")).toBeNull()
    expect(ahCalls).toBe(0)
  })

  it("an AgentHub `session` cookie alone is not a MidHub session", async () => {
    const page = await proxy(req("/", { headers: await withCookie("session") }))
    expect(location(page)!.pathname).toBe("/midhub/api/auth/agenthub")
    const api = await proxy(req("/api/mids", { headers: await withCookie("session") }))
    expect(api.status).toBe(401)
  })

  it("rejects a garbage midhub_session cookie (and clears it)", async () => {
    const res = await proxy(req("/api/mids", { headers: { cookie: "midhub_session=nope" } }))
    expect(res.status).toBe(401)
    expect(setCookie(res)).toMatch(/midhub_session=;.*Max-Age=0/)
  })

  it("an old local-login session (no ahAt) is invalid -> sign in again via AgentHub", async () => {
    const jose = await import("jose")
    const old = await new jose.SignJWT({ userId: "u1", email: "a@x.com", role: "admin", authAt: nowS() })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("bsm-midhub/session").setIssuedAt().setExpirationTime("4h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET ?? "dev-secret-change-in-production"))
    const res = await proxy(req("/", { headers: { cookie: `midhub_session=${old}` } }))
    expect(location(res)!.pathname).toBe("/midhub/api/auth/agenthub")
    expect(setCookie(res)).toMatch(/midhub_session=;.*Max-Age=0/)
  })

  it("valid fresh session passes and re-sets midhub_session (sliding), path /midhub, no AgentHub call", async () => {
    const res = await proxy(req("/api/mids", { headers: await withCookie("midhub_session") }))
    expect(res.status).toBe(200)
    const set = setCookie(res)
    expect(set).toContain("midhub_session=")
    expect(set).toContain("Path=/midhub")
    expect(set).toContain("Max-Age=14400")
    expect(ahCalls).toBe(0)
  })

  it("does not re-issue the session cookie on logout (it would fight the route's clearing cookie)", async () => {
    const res = await proxy(req("/api/auth/logout", { method: "POST", headers: await stale(301) }))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(ahCalls).toBe(0)
  })

  it("picks up allowlist changes immediately (no stale cache)", async () => {
    const h = { "x-forwarded-for": "8.8.8.8" }
    cidrs = ["10.0.0.0/8"]
    expect((await proxy(req("/api/x", { headers: h }))).status).toBe(403)
    cidrs = []
    expect((await proxy(req("/api/x", { headers: h }))).status).toBe(401)
  })

  it("/login and /api/auth/agenthub are public: never gated, never re-verified (no loop possible)", async () => {
    ah = { status: 500, body: "{}" }
    for (const p of ["/login", "/login?reason=unreachable", "/api/auth/agenthub", "/api/auth/agenthub?next=%2F"]) {
      for (const headers of [{}, await stale(301), { cookie: "midhub_session=nope" }]) {
        const res = await proxy(req(p, { headers }))
        expect(res.status, p).toBe(200)
        expect(res.headers.get("location"), p).toBeNull()
        expect(res.headers.get("set-cookie"), p).toBeNull() // never re-mint a possibly revoked session here
      }
    }
    expect(ahCalls).toBe(0)
  })

  it.each(["/api/auth/login", "/api/auth/idp", "/api/auth/oidc/start", "/api/auth/oidc/callback", "/api/auth/agenthubx", "/loginx"])(
    "the removed local-login paths are no longer public (%s)", async (p) => {
      const res = await proxy(req(p))
      expect(res.status === 401 || location(res)?.pathname === "/midhub/api/auth/agenthub", p).toBe(true)
    })
})

describe("AgentHub re-verification (ahAt older than 300 s)", () => {
  it("within 300 s: no AgentHub call", async () => {
    const res = await proxy(req("/api/mids", { headers: await stale(299) }))
    expect(res.status).toBe(200)
    expect(ahCalls).toBe(0)
  })

  it("after 300 s and still an admin: one lookup with only the AgentHub cookie, session re-issued with a fresh ahAt", async () => {
    const res = await proxy(req("/api/mids", { headers: await stale(301) }))
    expect(res.status).toBe(200)
    expect(ahCalls).toBe(1)
    expect(ahCookies).toEqual(["session=ah-cookie"])
    const p = await verifyToken(newSession(res)!)
    expect(p!.ahAt).toBeGreaterThanOrEqual(nowS() - 1)
    expect(setCookie(res).match(/midhub_session=/g)).toHaveLength(1) // one Set-Cookie, not re-verify + slide
  })

  it("pages are re-verified too", async () => {
    const res = await proxy(req("/mids/x", { headers: await stale(301) }))
    expect(res.status).toBe(200)
    expect(ahCalls).toBe(1)
  })

  it("demoted admin (AgentHub now says role user): page -> access page reason=not_admin, session cleared", async () => {
    ah = { status: 200, body: '{"email":"a@x.com","role":"user"}' }
    const res = await proxy(req("/mids/x", { headers: await stale(301) }))
    expect(res.status).toBe(307)
    expect(location(res)!.pathname).toBe("/midhub/login")
    expect(location(res)!.searchParams.get("reason")).toBe("not_admin")
    expect(setCookie(res)).toMatch(/midhub_session=;.*Max-Age=0/)
    expect(auditDenied).toHaveBeenCalledWith("not_admin", expect.objectContaining({ email: "a@x.com" }))
  })

  it("demoted admin on an API call -> 401 unauthenticated, session cleared", async () => {
    ah = { status: 200, body: '{"email":"a@x.com","role":"user"}' }
    const res = await proxy(req("/api/mids", { headers: await stale(301) }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "unauthenticated" })
    expect(setCookie(res)).toMatch(/midhub_session=;.*Max-Age=0/)
  })

  it("signed out of AgentHub -> reason=signed_out", async () => {
    ah = { status: 401, body: '{"error":"Unauthorized"}' }
    const res = await proxy(req("/", { headers: await stale(301) }))
    expect(location(res)!.searchParams.get("reason")).toBe("signed_out")
  })

  it("AgentHub unreachable -> access page reason=unreachable (fail closed), no 500, and the access page itself is not gated", async () => {
    const saved = ahBase
    ahBase = "http://127.0.0.1:1"
    try {
      const res = await proxy(req("/", { headers: await stale(301) }))
      expect(res.status).toBe(307)
      const l = location(res)!
      expect(l.pathname).toBe("/midhub/login")
      expect(l.searchParams.get("reason")).toBe("unreachable")
      // Following the redirect (cookie now cleared) renders the access page: no loop.
      const next = await proxy(req(l.pathname.replace("/midhub", "") + l.search))
      expect(next.status).toBe(200)
      expect(next.headers.get("location")).toBeNull()
    } finally {
      ahBase = saved
    }
  })

  it("AgentHub says a different admin is signed in now -> this session is dropped and the page signs in again", async () => {
    ah = { status: 200, body: '{"email":"other@x.com","role":"admin"}' }
    const page = await proxy(req("/mids", { headers: await stale(301) }))
    expect(location(page)!.pathname).toBe("/midhub/api/auth/agenthub")
    expect(setCookie(page)).toMatch(/midhub_session=;.*Max-Age=0/)
    const api = await proxy(req("/api/mids", { headers: await stale(301) }))
    expect(api.status).toBe(401)
  })

  it("background polls are re-verified but do not slide the idle expiry", async () => {
    const jose = await import("jose")
    const exp0 = nowS() + 4 * 3600 - 301 // as if signed 301 s ago
    const t0 = await signToken({ userId: "u1", email: "a@x.com", role: "admin", ahAt: nowS() - 301 }, { expiresAt: exp0 })
    const res = await proxy(req("/api/mids", { headers: { cookie: `midhub_session=${t0}; session=ah-cookie`, "x-background": "1" } }))
    expect(res.status).toBe(200)
    expect(ahCalls).toBe(1)
    const t = newSession(res)!
    const exp = jose.decodeJwt(t).exp!
    expect(exp).toBe(exp0) // kept the original expiry
    expect((await verifyToken(t))!.ahAt).toBeGreaterThanOrEqual(nowS() - 1)
  })
})

describe("/api/agent/* bypasses the proxy (I1: Next would clone and buffer request bodies)", () => {
  // Mirror Next exactly: compile config.matcher the way Next does (basePath prefix, data/transport suffixes)
  // and run it on the full pathname, as next-server does.
  const matches = (p: string) => getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, { basePath: "/midhub" }))(p, {} as never, {})
  it("the matcher excludes /api/agent/* but still covers everything else", () => {
    for (const p of ["/midhub/api/agent/mids", "/midhub/api/agent/mids/x/files", "/midhub/api/agent/mids/x/restart"]) expect(matches(p), p).toBe(false)
    for (const p of ["/midhub", "/midhub/", "/midhub/api/mids", "/midhub/api/mids/x/files", "/midhub/api/agentx", "/midhub/api/agentx/mids", "/midhub/api/agent", "/midhub/login", "/midhub/audit"]) {
      expect(matches(p), p).toBe(true)
    }
  })
  it("the bare app root /midhub is gated too (sign-in must start from the main entry), static assets are not", () => {
    expect(matches("/midhub")).toBe(true)
    for (const p of ["/midhub/_next/static/chunks/a.js", "/midhub/_next/image", "/midhub/logo-mfec-black.png", "/midhub/favicon.ico"]) {
      expect(matches(p), p).toBe(false)
    }
  })
  it("the proxy itself has no agent exemption left: called anyway, it gates like any API path", async () => {
    expect((await proxy(req("/api/agent/mids"))).status).toBe(401)
    expect((await proxy(req("/api/agentx/mids"))).status).toBe(401)
    expect((await proxy(req("/api/agent"))).status).toBe(401)
  })
})

describe("background polls (M2)", () => {
  it("X-Background: 1 passes but does not slide the session", async () => {
    const res = await proxy(req("/api/mids", { headers: await withCookie("midhub_session", { "x-background": "1" }) }))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
  })
  it("a normal request still slides", async () => {
    const res = await proxy(req("/api/mids", { headers: await withCookie("midhub_session") }))
    expect(res.headers.get("set-cookie") ?? "").toContain("midhub_session=")
  })
})

describe("CSRF origin check on unsafe API methods (M1)", () => {
  const unsafe = async (method: string, h: Record<string, string>, path = "/api/mids/m1/actions") =>
    proxy(req(path, { method, headers: await withCookie("midhub_session", { host: "localhost:3100", ...h }) }))

  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s with a foreign Origin -> 403", async (m) => {
    const res = await unsafe(m, { origin: "https://evil.example" })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("csrf")
  })
  it("Sec-Fetch-Site cross-site / same-site -> 403", async () => {
    expect((await unsafe("POST", { "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect((await unsafe("POST", { "sec-fetch-site": "same-site" })).status).toBe(403)
  })
  it("same-origin Origin, Sec-Fetch-Site same-origin/none, or no headers (curl) pass", async () => {
    expect((await unsafe("POST", { origin: "http://localhost:3100" })).status).toBe(200)
    expect((await unsafe("POST", { origin: "https://localhost:3100" })).status).toBe(200) // TLS ends at Caddy
    expect((await unsafe("POST", { "sec-fetch-site": "same-origin" })).status).toBe(200)
    expect((await unsafe("POST", { "sec-fetch-site": "none" })).status).toBe(200)
    expect((await unsafe("POST", {})).status).toBe(200)
  })
  it("also guards the public sign-in route; GET is never blocked", async () => {
    const signIn = await proxy(req("/api/auth/agenthub", { method: "POST", headers: { host: "localhost:3100", origin: "https://evil.example" } }))
    expect(signIn.status).toBe(403)
    expect((await unsafe("GET", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, "/api/mids")).status).toBe(200)
  })
})
