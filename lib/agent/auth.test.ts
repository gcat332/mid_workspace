import { describe, it, expect, vi, beforeEach } from "vitest"

const SECRET = "Zq7-distinct-secret-value-Zq7-" + "k".repeat(16)
const fakeEnv = vi.hoisted(() => ({ agentSecret: "Zq7-distinct-secret-value-Zq7-" + "k".repeat(16) as string | null }))
vi.mock("@/lib/env", () => ({ env: fakeEnv }))
let dbUser: { id: string; email: string; role: string; lockedAt: Date | null } | null = null
const findUnique = vi.fn(async (...args: unknown[]) => (void args, dbUser))
let cidrs: string[] = []
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a) },
    ipAllowlist: { findMany: async () => cidrs.map((cidr) => ({ cidr })) },
  },
}))

import { authenticateAgent, parseSessionInstances, cameDirectlyOverLoopback } from "./auth"
import { agentRoute } from "./http"

const hdrs = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    host: "127.0.0.1:3100",
    "x-midhub-agent-secret": SECRET,
    "x-midhub-actor-email": "Alice@X.com",
    "x-midhub-session-id": "task-1",
    "x-midhub-session-instances": "",
    ...over,
  }
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== null) h[k] = v
  return h
}
const req = (over: Record<string, string | null> = {}) => new Request("http://127.0.0.1:3100/midhub/api/agent/mids", { headers: hdrs(over) })
const fail = async (r: Request) => authenticateAgent(r).then(() => null, (e) => e as { code: string; status: number; message: string })

beforeEach(() => {
  fakeEnv.agentSecret = SECRET
  dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: null }
  findUnique.mockClear()
  cidrs = []
})

describe("authenticateAgent", () => {
  it("feature off -> 404 not_found", async () => {
    fakeEnv.agentSecret = null
    expect(await fail(req())).toMatchObject({ code: "not_found", status: 404 })
  })
  it("missing or wrong secret -> 401 agent_auth", async () => {
    expect(await fail(req({ "x-midhub-agent-secret": null }))).toMatchObject({ code: "agent_auth", status: 401 })
    expect(await fail(req({ "x-midhub-agent-secret": "x" }))).toMatchObject({ code: "agent_auth", status: 401 })
    expect(await fail(req({ "x-midhub-agent-secret": SECRET + "x" }))).toMatchObject({ code: "agent_auth", status: 401 })
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("correct secret + public X-Forwarded-For -> 403 agent_auth, no DB lookup", async () => {
    expect(await fail(req({ "x-forwarded-for": "1.2.3.4" }))).toMatchObject({ code: "agent_auth", status: 403 })
    expect(await fail(req({ "x-forwarded-for": "127.0.0.1, 1.2.3.4" }))).toMatchObject({ code: "agent_auth", status: 403 })
    expect(await fail(req({ "x-real-ip": "8.8.8.8" }))).toMatchObject({ code: "agent_auth", status: 403 })
    expect(await fail(req({ forwarded: 'for="[2001:db8::1]:80";proto=https' }))).toMatchObject({ code: "agent_auth", status: 403 })
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("accepts loopback-only forwarding headers (what Next injects for a direct call)", async () => {
    for (const xff of ["::ffff:127.0.0.1", "::1", "127.0.0.1", "127.5.6.7, ::1"]) {
      expect(await fail(req({ "x-forwarded-for": xff }))).toBeNull()
    }
  })
  it("wrong secret wins over forwarding headers: 401, not 403", async () => {
    expect(await fail(req({ "x-midhub-agent-secret": "bad", "x-forwarded-for": "1.2.3.4" }))).toMatchObject({ code: "agent_auth", status: 401 })
  })
  it("IP allowlist still applies (the proxy no longer runs here): after the secret, before the loopback check", async () => {
    cidrs = ["10.0.0.0/8"]
    const blocked = await fail(req({ "x-forwarded-for": "8.8.8.8" }))
    expect(blocked).toBeInstanceOf(Response)
    const r = blocked as unknown as Response
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ code: "ip_blocked", message: "IP ของคุณ (8.8.8.8) ไม่อยู่ใน IP Allowlist กรุณาให้ Admin เพิ่ม IP นี้", ip: "8.8.8.8" })
    expect(await fail(req({ "x-midhub-agent-secret": "bad", "x-forwarded-for": "8.8.8.8" }))).toMatchObject({ code: "agent_auth", status: 401 })
    expect(await fail(req({ "x-forwarded-for": "::ffff:127.0.0.1" }))).toBeNull() // loopback is always allowed
    expect(findUnique).toHaveBeenCalledTimes(1)
    const viaRoute = await agentRoute(async () => new Response("ran"))(req({ "x-forwarded-for": "8.8.8.8" }), undefined)
    expect(viaRoute.status).toBe(403)
    expect((await viaRoute.json()).code).toBe("ip_blocked")
  })
  it("401 carries the exact catalogue text", async () => {
    expect((await fail(req({ "x-midhub-agent-secret": "bad" })))!.message).toBe("AgentHub ยืนยันตัวตนกับ MidHub ไม่ผ่าน ตรวจ MIDHUB_AGENT_SECRET ทั้งสองฝั่ง")
  })
  it("requires a loopback Host (a request through Caddy keeps the public Host)", async () => {
    for (const host of ["10.4.150.142", "dev-agenthub.mfec.co.th", "127.0.0.1.evil.com", "localhost.evil.com:3100", ""]) {
      expect(await fail(req({ host }))).toMatchObject({ code: "agent_auth", status: 403 })
    }
    expect(await fail(req({ host: null }))).toMatchObject({ code: "agent_auth", status: 403 })
    for (const host of ["127.0.0.1:3100", "localhost:3100", "[::1]:3100", "127.0.0.1", "localhost", "LOCALHOST:3100"]) {
      expect(await fail(req({ host }))).toBeNull()
    }
    expect(findUnique).toHaveBeenCalledTimes(6)
  })
  it("a spoofed loopback XFF with a public Host is still refused", async () => {
    expect(await fail(req({ "x-forwarded-for": "127.0.0.1", host: "10.4.150.142" }))).toMatchObject({ code: "agent_auth", status: 403 })
  })
  it("no secret value in the serialized body of any error response", async () => {
    dbUser = null
    const cases = [
      req({ "x-midhub-agent-secret": "bad" }),
      req({ "x-forwarded-for": "1.2.3.4" }),
      req({ host: "10.4.150.142" }),
      req(), // agent_user (no such account)
      req({ "x-midhub-session-id": null }),
    ]
    const statuses: number[] = []
    for (const r of cases) {
      const res = await agentRoute(async () => new Response("ok"))(r, {})
      statuses.push(res.status)
      const body = await res.text()
      expect(body).not.toContain(SECRET)
      expect(body).not.toContain("Zq7")
    }
    expect(statuses).toEqual([401, 403, 403, 403, 400])
  })
  it("unknown, missing-email or locked actor -> 403 agent_user", async () => {
    dbUser = null
    expect(await fail(req())).toMatchObject({ code: "agent_user", status: 403 })
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: null }
    expect(await fail(req({ "x-midhub-actor-email": null }))).toMatchObject({ code: "agent_user", status: 403 })
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: new Date() }
    const e = await fail(req())
    expect(e).toMatchObject({ code: "agent_user", status: 403 })
    expect(e!.message).toBe("ผู้ใช้ alice@x.com ยังไม่มีสิทธิ์ใช้ MidHub ให้ Admin เพิ่มในหน้า Users")
  })
  it("a lock never expires on its own (admin lock, no password lockout any more)", async () => {
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: new Date(Date.now() - 3600_000) }
    expect(await fail(req())).toMatchObject({ code: "agent_user", status: 403 })
  })
  it("role and identity come from the DB; email is lowercased for the lookup; checked every call", async () => {
    dbUser = { id: "u9", email: "alice@x.com", role: "admin", lockedAt: null }
    const c = await authenticateAgent(req())
    expect(c.user).toEqual({ userId: "u9", email: "alice@x.com", role: "admin", ahAt: expect.any(Number) })
    expect(c.taskId).toBe("task-1")
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: "alice@x.com" } }))
    await authenticateAgent(req())
    expect(findUnique).toHaveBeenCalledTimes(2)
  })
  it("missing/bad session id -> agent_auth", async () => {
    expect(await fail(req({ "x-midhub-session-id": null }))).toMatchObject({ code: "agent_auth" })
    expect(await fail(req({ "x-midhub-session-id": "a b" }))).toMatchObject({ code: "agent_auth" })
  })
  it("parses sessionInstances", async () => {
    const c = await authenticateAgent(req({ "x-midhub-session-instances": "https://A.service-now.com, junk,https://a.service-now.com/" }))
    expect(c.sessionInstances).toEqual(["https://a.service-now.com/"])
  })
})

describe("helpers", () => {
  it("parseSessionInstances: empty/null -> []", () => {
    expect(parseSessionInstances(null)).toEqual([])
    expect(parseSessionInstances("")).toEqual([])
    expect(parseSessionInstances("http://a.service-now.com,https://evil.com")).toEqual([])
  })
  it("cameDirectlyOverLoopback: only a loopback Host and no forwarding headers", () => {
    expect(cameDirectlyOverLoopback(new Headers({ host: "127.0.0.1:3100" }))).toBe(true)
    expect(cameDirectlyOverLoopback(new Headers())).toBe(false)
  })
})

describe("agentRoute", () => {
  it("returns the MidError JSON shape and skips the handler on auth failure", async () => {
    const handler = vi.fn(async () => new Response("ok"))
    const res = await agentRoute(handler)(req({ "x-midhub-agent-secret": "bad" }), {})
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "agent_auth" })
    expect(handler).not.toHaveBeenCalled()
  })
  it("404s everything when the feature is off", async () => {
    fakeEnv.agentSecret = null
    const res = await agentRoute(async () => new Response("ok"))(req(), {})
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: "not_found" })
  })
  it("passes caller and ctx to the handler", async () => {
    const res = await agentRoute<{ n: number }>(async (_r, c, ctx) => Response.json({ e: c.user.email, n: ctx.n }))(req(), { n: 7 })
    expect(await res.json()).toEqual({ e: "alice@x.com", n: 7 })
  })
})
