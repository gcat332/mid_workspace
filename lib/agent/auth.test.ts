import { describe, it, expect, vi, beforeEach } from "vitest"

const SECRET = "s".repeat(40)
const fakeEnv = vi.hoisted(() => ({ agentSecret: "s".repeat(40) as string | null }))
vi.mock("@/lib/env", () => ({ env: fakeEnv }))
let dbUser: { id: string; email: string; role: string; lockedAt: Date | null } | null = null
const findUnique = vi.fn(async (...args: unknown[]) => (void args, dbUser))
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique: (a: unknown) => findUnique(a) } } }))

import { authenticateAgent, parseSessionInstances, cameDirectlyOverLoopback } from "./auth"
import { agentRoute } from "./http"

const hdrs = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
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
  it("no secret value in any error", async () => {
    for (const r of [req({ "x-forwarded-for": "1.2.3.4" }), req({ "x-midhub-agent-secret": "nope" })]) {
      expect(JSON.stringify(await fail(r))).not.toContain(SECRET)
    }
  })
  it("unknown, missing-email or locked actor -> 403 agent_user", async () => {
    dbUser = null
    expect(await fail(req())).toMatchObject({ code: "agent_user", status: 403 })
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: null }
    expect(await fail(req({ "x-midhub-actor-email": null }))).toMatchObject({ code: "agent_user", status: 403 })
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: new Date() }
    const e = await fail(req())
    expect(e).toMatchObject({ code: "agent_user", status: 403 })
    expect(e!.message).toContain("ยังไม่มีสิทธิ์ใช้ MidHub")
  })
  it("an expired lock does not block", async () => {
    dbUser = { id: "u1", email: "alice@x.com", role: "member", lockedAt: new Date(Date.now() - 3600_000) }
    expect(await fail(req())).toBeNull()
  })
  it("role and identity come from the DB; email is lowercased for the lookup; checked every call", async () => {
    dbUser = { id: "u9", email: "alice@x.com", role: "admin", lockedAt: null }
    const c = await authenticateAgent(req())
    expect(c.user).toEqual({ userId: "u9", email: "alice@x.com", role: "admin" })
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
  it("cameDirectlyOverLoopback: no headers is fine", () => {
    expect(cameDirectlyOverLoopback(new Headers())).toBe(true)
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
