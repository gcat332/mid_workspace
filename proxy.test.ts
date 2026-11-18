import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { signToken } from "@/lib/auth/jwt"

let cidrs: string[] = []
vi.mock("@/lib/db/client", () => ({
  prisma: { ipAllowlist: { findMany: vi.fn(async () => cidrs.map((cidr) => ({ cidr }))) } },
}))

import { proxy } from "@/proxy"

// Real Next strips basePath from request.nextUrl.pathname in the proxy; NextRequest only does the
// same when told the basePath via nextConfig. Passing it makes these tests behave like production.
const req = (path: string, init: { headers?: Record<string, string>; method?: string } = {}) =>
  new NextRequest(`http://localhost:3100/midhub${path}`, {
    ...init,
    nextConfig: { basePath: "/midhub" },
  } as ConstructorParameters<typeof NextRequest>[1])

const withCookie = async (name: string, headers: Record<string, string> = {}) => ({
  ...headers,
  cookie: `${name}=${await signToken({ userId: "u1", email: "a@x.com", role: "admin" })}`,
})

beforeEach(() => {
  cidrs = []
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
    expect(await res.json()).toEqual({ error: "Forbidden", ip: "8.8.8.8" })
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
  it("redirects a page without a cookie to /midhub/login and sets login_next", async () => {
    const res = await proxy(req("/mids?x=1"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/midhub/login")
    expect(res.headers.get("set-cookie")).toContain("login_next=%2Fmidhub%2Fmids%3Fx%3D1")
  })

  it("redirects /midhub/ to /midhub/login", async () => {
    const res = await proxy(req("/"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/midhub/login")
  })

  it("401 JSON for an API call without a cookie", async () => {
    const res = await proxy(req("/api/mids"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  })

  it("treats an AgentHub `session` cookie alone as logged out", async () => {
    const page = await proxy(req("/", { headers: await withCookie("session") }))
    expect(page.status).toBe(307)
    const api = await proxy(req("/api/mids", { headers: await withCookie("session") }))
    expect(api.status).toBe(401)
  })

  it("rejects a garbage midhub_session cookie", async () => {
    const res = await proxy(req("/api/mids", { headers: { cookie: "midhub_session=nope" } }))
    expect(res.status).toBe(401)
  })

  it("valid cookie passes and re-sets midhub_session (sliding), path /midhub", async () => {
    const res = await proxy(req("/api/mids", { headers: await withCookie("midhub_session") }))
    expect(res.status).toBe(200)
    const set = res.headers.get("set-cookie") ?? ""
    expect(set).toContain("midhub_session=")
    expect(set).toContain("Path=/midhub")
    expect(set).toContain("Max-Age=14400")
  })

  it("does not re-issue the session cookie on logout (it would fight the route's clearing cookie)", async () => {
    const res = await proxy(req("/api/auth/logout", { method: "POST", headers: await withCookie("midhub_session") }))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("picks up allowlist changes immediately (no stale cache)", async () => {
    const h = { "x-forwarded-for": "8.8.8.8" }
    cidrs = ["10.0.0.0/8"]
    expect((await proxy(req("/api/x", { headers: h }))).status).toBe(403)
    cidrs = []
    expect((await proxy(req("/api/x", { headers: h }))).status).toBe(401)
  })

  it.each(["/login", "/api/auth/login", "/api/auth/idp", "/api/auth/oidc/start", "/api/auth/oidc/callback"])(
    "%s is public", async (p) => {
      const res = await proxy(req(p))
      expect(res.status).toBe(200)
    })

  it("does not treat /login/x or /api/auth/oidc-evil as public", async () => {
    expect((await proxy(req("/api/auth/loginx"))).status).toBe(401)
    expect((await proxy(req("/api/auth/oidcx/start"))).status).toBe(401)
  })

  it("sends an already-signed-in user away from /login", async () => {
    const res = await proxy(req("/login", { headers: await withCookie("midhub_session") }))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/midhub")
  })
})
