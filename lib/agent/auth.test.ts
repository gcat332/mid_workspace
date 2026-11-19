import { describe, it, expect, vi, beforeEach } from "vitest"

const SECRET = "Zq7-distinct-secret-value-Zq7-" + "k".repeat(16)
const fakeEnv = vi.hoisted(() => ({ agentSecret: "Zq7-distinct-secret-value-Zq7-" + "k".repeat(16) as string | null }))
vi.mock("@/lib/env", () => ({ env: fakeEnv }))
let dbUser: { id: string; email: string; role: string; lockedAt: Date | null } | null = null
const findUnique = vi.fn(async (...args: unknown[]) => (void args, dbUser))
const upsert = vi.fn(async (a: { where: { email: string }; create: { role: string; email: string }; update: Record<string, unknown> }) => {
  if (dbUser) { dbUser = { ...dbUser, role: "admin" }; return { id: dbUser.id, email: dbUser.email } }
  dbUser = { id: "new1", email: a.create.email, role: a.create.role, lockedAt: null }
  return { id: "new1", email: a.create.email }
})
const update = vi.fn()
let cidrs: string[] = []
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a), upsert: (a: never) => upsert(a), update: (a: unknown) => update(a) },
    ipAllowlist: { findMany: async () => cidrs.map((cidr) => ({ cidr })) },
  },
}))

const audit = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))

import { authenticateAgent, parseSessionInstances, cameDirectlyOverLoopback } from "./auth"
import { agentRoute } from "./http"

const hdrs = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    host: "127.0.0.1:3100",
    "x-midhub-agent-secret": SECRET,
    "x-midhub-actor-email": "Alice@X.com",
    "x-midhub-actor-role": "admin",
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
  upsert.mockClear()
  audit.mockClear()
  update.mockClear()
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
  // Deployed AgentHub proxy: the browser's Host and the F5's client IP pass through, so the loopback Host and XFF
  // checks refuse it on their own (and AgentHub strips the secret header before this is even reached).
  it("refuses the deployed AgentHub proxy shape (Host = browser host, XFF = client IP) -> 403 agent_auth", async () => {
    const e = await fail(req({ host: "dev-agenthub.mfec.co.th", "x-forwarded-host": "dev-agenthub.mfec.co.th", "x-forwarded-for": "10.20.30.40" }))
    expect(e).toMatchObject({ code: "agent_auth", status: 403 })
    expect(await fail(req({ host: "dev-agenthub.mfec.co.th", "x-forwarded-for": "10.6.141.20" }))).toMatchObject({ code: "agent_auth", status: 403 })
    expect(findUnique).not.toHaveBeenCalled()
  })
  // Hypothetical real Next rewrite (/midhub/:path* -> 127.0.0.1:3100, changeOrigin; not what AgentHub runs): Host
  // loopback and XFF loopback when the client sent none, so only X-Forwarded-Host tells it apart from AgentHub's own fetch.
  it("refuses a request forwarded through AgentHub's rewrite (X-Forwarded-Host = browser host) -> 403 agent_auth", async () => {
    for (const xfh of ["dev-agenthub.mfec.co.th", "evil.com", "127.0.0.1:3000", "localhost:3100", "", "127.0.0.1:3100, dev-agenthub.mfec.co.th"]) {
      const e = await fail(req({ "x-forwarded-host": xfh, "x-forwarded-for": "::ffff:127.0.0.1" }))
      expect(e, xfh).toMatchObject({ code: "agent_auth", status: 403 })
    }
    // Rewrite shape with the F5's client IP: still 403 (and never reaches the DB).
    expect(await fail(req({ "x-forwarded-host": "dev-agenthub.mfec.co.th", "x-forwarded-for": "10.20.30.40", "x-forwarded-proto": "http" })))
      .toMatchObject({ code: "agent_auth", status: 403 })
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("accepts the X-Forwarded-Host Next itself injects on a direct call (a copy of Host)", async () => {
    // Verified on next dev 16.4.6: a plain curl to 127.0.0.1:<port> reaches the route with
    // x-forwarded-host = Host and x-forwarded-for = ::ffff:127.0.0.1 (base-server.js `??=`).
    expect(await fail(req({ "x-forwarded-host": "127.0.0.1:3100", "x-forwarded-for": "::ffff:127.0.0.1" }))).toBeNull()
    expect(await fail(req({ host: "localhost:3100", "x-forwarded-host": "LOCALHOST:3100" }))).toBeNull()
  })
  it("no secret value in the serialized body of any error response", async () => {
    const cases = [
      req({ "x-midhub-agent-secret": "bad" }),
      req({ "x-forwarded-for": "1.2.3.4" }),
      req({ host: "10.4.150.142" }),
      req({ "x-midhub-actor-role": "user" }), // agent_user (not an AgentHub admin)
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
  const ROLE_MSG = "ต้องเป็น admin ของ AgentHub (บัญชี alice@x.com)"
  it("missing, user or wrong-case role -> 403 agent_user, nothing written", async () => {
    for (const role of [null, "user", "Admin", "ADMIN", "member", ""]) {
      const e = await fail(req({ "x-midhub-actor-role": role }))
      expect(e).toMatchObject({ code: "agent_user", status: 403, message: ROLE_MSG })
    }
    expect(upsert).not.toHaveBeenCalled()
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("missing email -> 403 agent_user", async () => {
    expect(await fail(req({ "x-midhub-actor-email": null }))).toMatchObject({ code: "agent_user", status: 403 })
  })
  it("invalid actor email (junk, whitespace, over 254 chars) -> 403 agent_user, no DB access, never truncated", async () => {
    for (const email of ["x", "a b", `${"a".repeat(300)}@x.com`, `${"a".repeat(250)}@x.com`]) {
      const e = await fail(req({ "x-midhub-actor-email": email }))
      expect(e).toMatchObject({ code: "agent_user", status: 403 })
      expect(e!.message).toContain("อีเมล")
    }
    expect(findUnique).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
    expect(await fail(req({ "x-midhub-actor-email": "ok.user@x.com" }))).toBeNull()
  })
  it("a new user is audited once as user.created; an existing admin writes nothing", async () => {
    dbUser = null
    await authenticateAgent(req())
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: "new1", email: "alice@x.com" }), "user.created", undefined, { via: "agenthub", email: "alice@x.com" })
    audit.mockClear(); upsert.mockClear()
    dbUser = { id: "u1", email: "alice@x.com", role: "admin", lockedAt: null }
    await authenticateAgent(req())
    expect(upsert).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: null }
    await authenticateAgent(req())
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(audit).not.toHaveBeenCalled()
  })
  it("admin with an unknown email -> ok and the user is created as admin (never opened MidHub)", async () => {
    dbUser = null
    const c = await authenticateAgent(req())
    expect(c.user).toEqual({ userId: "new1", email: "alice@x.com", role: "admin", ahAt: expect.any(Number) })
    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0][0]
    expect(arg.create).toMatchObject({ email: "alice@x.com", role: "admin" })
    expect(arg.create).not.toHaveProperty("lastLoginAt")
    expect(arg.update).toEqual({ role: "admin" })
  })
  it("admin with a locked MidHub user -> 403 agent_user (a lock never expires on its own)", async () => {
    for (const lockedAt of [new Date(), new Date(Date.now() - 3600_000)]) {
      dbUser = { id: "u1", email: "alice@x.com", role: "admin", lockedAt }
      expect(await fail(req())).toMatchObject({ code: "agent_user", status: 403 })
    }
    expect(upsert).not.toHaveBeenCalled()
  })
  it("a MidHub member row is promoted to admin by the upsert; identity comes from the DB row, checked every call", async () => {
    dbUser = { id: "u9", email: "alice@x.com", role: "member", lockedAt: null }
    const c = await authenticateAgent(req())
    expect(c.user).toEqual({ userId: "u9", email: "alice@x.com", role: "admin", ahAt: expect.any(Number) })
    expect(c.taskId).toBe("task-1")
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: "alice@x.com" } }))
    await authenticateAgent(req())
    expect(findUnique).toHaveBeenCalledTimes(2)
  })
  it("wrong secret beats a bad role: 401", async () => {
    expect(await fail(req({ "x-midhub-agent-secret": "bad", "x-midhub-actor-role": "user" }))).toMatchObject({ code: "agent_auth", status: 401 })
  })
  it("a bad session id beats the role check: 400", async () => {
    expect(await fail(req({ "x-midhub-session-id": null, "x-midhub-actor-role": "user" }))).toMatchObject({ code: "agent_auth", status: 400 })
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
    expect(cameDirectlyOverLoopback(new Headers({ host: "127.0.0.1:3100", "x-forwarded-host": "127.0.0.1:3100" }))).toBe(true)
    expect(cameDirectlyOverLoopback(new Headers({ host: "127.0.0.1:3100", "x-forwarded-host": "dev-agenthub.mfec.co.th" }))).toBe(false)
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
