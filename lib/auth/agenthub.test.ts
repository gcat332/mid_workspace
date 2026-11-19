import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"

// Fake AgentHub on a random loopback port. Each test sets `reply`; every request it sees is recorded.
type Reply = { status: number; body?: string; headers?: Record<string, string>; delayMs?: number }
let reply: Reply = { status: 401, body: '{"error":"Unauthorized"}' }
let seen: { url?: string; headers: http.IncomingHttpHeaders }[] = []
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers })
  const send = () => {
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers })
    res.end(reply.body ?? "")
  }
  if (reply.delayMs) setTimeout(send, reply.delayMs)
  else send()
})
let base = "http://127.0.0.1:1"
vi.mock("@/lib/env", () => ({ env: { get agenthubUrl() { return base } } }))

const findUnique = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null))
const upsert = vi.hoisted(() => vi.fn(async (a: { create: { email: string } }) => ({ id: "u9", email: a.create.email, role: "admin" })))
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique, upsert } } }))

import { lookupAgentHubAdmin, signInFromAgentHub } from "./agenthub"

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => {
  seen = []
  findUnique.mockReset(); findUnique.mockResolvedValue(null)
  upsert.mockClear()
})

describe("lookupAgentHubAdmin", () => {
  const COOKIE = "eyJhbGciOiJIUzI1NiJ9.abc.def"

  it.each<[string, Reply, unknown]>([
    ["200 admin", { status: 200, body: '{"email":"Admin@X.com","role":"admin"}' }, { ok: true, email: "admin@x.com" }],
    ["200 non-admin role", { status: 200, body: '{"email":"u@x.com","role":"user"}' }, { ok: false, reason: "not_admin" }],
    ["200 role Admin (case-sensitive)", { status: 200, body: '{"email":"u@x.com","role":"Admin"}' }, { ok: false, reason: "not_admin" }],
    ["200 admin without email", { status: 200, body: '{"role":"admin"}' }, { ok: false, reason: "unreachable" }],
    ["200 admin with a bad email", { status: 200, body: '{"email":"not an email","role":"admin"}' }, { ok: false, reason: "unreachable" }],
    ["200 not JSON", { status: 200, body: "<html>" }, { ok: false, reason: "unreachable" }],
    ["401", { status: 401, body: '{"error":"Unauthorized"}' }, { ok: false, reason: "signed_out" }],
    ["403", { status: 403, body: "{}" }, { ok: false, reason: "signed_out" }],
    ["500", { status: 500, body: "{}" }, { ok: false, reason: "unreachable" }],
    ["302 to elsewhere (never followed)", { status: 302, headers: { location: "http://127.0.0.1:9/steal" } }, { ok: false, reason: "unreachable" }],
  ])("%s", async (_label, r, expected) => {
    reply = r
    expect(await lookupAgentHubAdmin(COOKIE)).toEqual(expected)
    expect(seen).toHaveLength(1) // a redirect is not followed
  })

  it("sends only Cookie: session=<value> to GET /api/auth/me", async () => {
    reply = { status: 200, body: '{"email":"a@x.com","role":"admin"}' }
    await lookupAgentHubAdmin(COOKIE)
    expect(seen[0].url).toBe("/api/auth/me")
    expect(seen[0].headers.cookie).toBe(`session=${COOKIE}`)
    expect(seen[0].headers.authorization).toBeUndefined()
    expect(seen[0].headers["x-forwarded-for"]).toBeUndefined()
  })

  it("no cookie (or an unsendable one) -> signed_out without asking AgentHub", async () => {
    expect(await lookupAgentHubAdmin(undefined)).toEqual({ ok: false, reason: "signed_out" })
    expect(await lookupAgentHubAdmin("")).toEqual({ ok: false, reason: "signed_out" })
    expect(await lookupAgentHubAdmin("a;b")).toEqual({ ok: false, reason: "signed_out" })
    expect(await lookupAgentHubAdmin("a\r\nX-Evil: 1")).toEqual({ ok: false, reason: "signed_out" })
    expect(await lookupAgentHubAdmin("x".repeat(9000))).toEqual({ ok: false, reason: "signed_out" })
    expect(seen).toHaveLength(0)
  })

  it("AgentHub down (connection refused) -> unreachable", async () => {
    const saved = base
    base = "http://127.0.0.1:1"
    try {
      expect(await lookupAgentHubAdmin(COOKIE)).toEqual({ ok: false, reason: "unreachable" })
    } finally {
      base = saved
    }
  })

  it("AgentHub slower than 5 s -> unreachable", async () => {
    reply = { status: 200, body: '{"email":"a@x.com","role":"admin"}', delayMs: 6000 }
    const t0 = Date.now()
    expect(await lookupAgentHubAdmin(COOKIE)).toEqual({ ok: false, reason: "unreachable" })
    expect(Date.now() - t0).toBeLessThan(5900)
  }, 10_000)

  it("the cookie value never appears in what it returns or logs", async () => {
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")]
    reply = { status: 500, body: "{}" }
    const out = await lookupAgentHubAdmin(COOKIE)
    expect(JSON.stringify(out)).not.toContain(COOKIE)
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(COOKIE)
      s.mockRestore()
    }
  })
})

describe("signInFromAgentHub", () => {
  it("upserts the email as an admin and returns a session with fresh authAt/ahAt", async () => {
    const now = Math.floor(Date.now() / 1000)
    const s = await signInFromAgentHub("New@X.com")
    expect(s).toMatchObject({ userId: "u9", email: "new@x.com", role: "admin" })
    expect(s.ahAt).toBeGreaterThanOrEqual(now)
    expect(s.authAt).toBe(s.ahAt)
    const arg = upsert.mock.calls[0][0] as unknown as { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }
    expect(arg.where).toEqual({ email: "new@x.com" })
    expect(arg.create).toMatchObject({ email: "new@x.com", role: "admin", passwordHash: "" })
    expect(arg.update).toMatchObject({ role: "admin" })
    expect(arg.update.lastLoginAt).toBeInstanceOf(Date)
  })

  it("a locked MidHub user is refused even though AgentHub says admin", async () => {
    findUnique.mockResolvedValue({ lockedAt: new Date(Date.now() - 24 * 3600_000) })
    await expect(signInFromAgentHub("a@x.com")).rejects.toMatchObject({ code: "account_locked" })
    expect(upsert).not.toHaveBeenCalled()
  })
})
