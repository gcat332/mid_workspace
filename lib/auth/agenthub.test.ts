import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"

// Fake AgentHub on a random loopback port. Each test sets `reply`; every request it sees is recorded.
// It models a DB-backed /api/auth/me (role read from AgentHub's DB on every call, as the AgentHub patch plan's
// "Task 0" requires). The real /me currently returns the role cached in AgentHub's session JWT, so a demotion only
// shows up here once that change is applied (see deploy/README.md "Demoting an admin").
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
let envError: Error | null = null
vi.mock("@/lib/env", () => ({ env: { get agenthubUrl() { if (envError) throw envError; return base } } }))

const findUnique = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null))
const upsert = vi.hoisted(() => vi.fn(async (a: { create: { email: string } }) => ({ id: "u9", email: a.create.email, role: "admin" })))
const update = vi.hoisted(() => vi.fn(async (a: { where: { email: string } }) => ({ id: "u-race", email: a.where.email })))
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique, upsert, update } } }))

import { lookupAgentHubAdmin, signInFromAgentHub } from "./agenthub"

// A loopback port with nothing listening (connection refused). Port 1 would not do: fetch refuses it as a "bad port".
async function closedPort(): Promise<string> {
  const s = http.createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return `http://127.0.0.1:${port}`
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => {
  seen = []
  findUnique.mockReset(); findUnique.mockResolvedValue(null)
  upsert.mockClear(); update.mockClear()
  envError = null
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
    base = await closedPort()
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

  it("logs the cause of every unreachable outcome (console.warn) without the cookie value or any header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const others = [vi.spyOn(console, "error"), vi.spyOn(console, "log")]
    try {
      reply = { status: 500, body: "{}" }
      await lookupAgentHubAdmin(COOKIE)
      reply = { status: 302, headers: { location: "http://x/" } }
      await lookupAgentHubAdmin(COOKIE)
      reply = { status: 200, body: "<html>" }
      await lookupAgentHubAdmin(COOKIE)
      reply = { status: 200, body: '{"role":"admin"}' }
      await lookupAgentHubAdmin(COOKIE)
      const saved = base
      base = await closedPort()
      try { await lookupAgentHubAdmin(COOKIE) } finally { base = saved }
      const lines = warn.mock.calls.map((c) => c.map(String).join(" "))
      expect(lines).toHaveLength(5)
      expect(lines[0]).toMatch(/status 500/)
      expect(lines[1]).toMatch(/status 302/)
      expect(lines[2]).toMatch(/not JSON/)
      expect(lines[3]).toMatch(/no valid email/)
      expect(lines[4]).toMatch(/ECONNREFUSED/)
      const all = JSON.stringify(warn.mock.calls) + JSON.stringify(others.map((o) => o.mock.calls))
      expect(all).not.toContain(COOKIE)
      expect(all.toLowerCase()).not.toContain("cookie")
      // signed_out / not_admin are normal outcomes, not logged
      warn.mockClear()
      reply = { status: 401, body: "{}" }
      await lookupAgentHubAdmin(COOKIE)
      reply = { status: 200, body: '{"email":"u@x.com","role":"user"}' }
      await lookupAgentHubAdmin(COOKIE)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore(); for (const o of others) o.mockRestore()
    }
  })

  it("a timeout is logged as such", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    reply = { status: 200, body: "{}", delayMs: 6000 }
    await lookupAgentHubAdmin(COOKIE)
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/timeout/i)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(COOKIE)
    warn.mockRestore()
  }, 10_000)

  it("a configuration error (bad AGENTHUB_URL) is not disguised as unreachable: it throws with its message", async () => {
    envError = new Error("AGENTHUB_URL must be http://127.0.0.1:<port>")
    await expect(lookupAgentHubAdmin(COOKIE)).rejects.toThrow(/AGENTHUB_URL/)
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

  it("first sign-in race: a unique-constraint error on the upsert falls back to the row the other request created", async () => {
    upsert.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }))
    const s = await signInFromAgentHub("Race@X.com")
    expect(s).toMatchObject({ userId: "u-race", email: "race@x.com", role: "admin" })
    const arg = update.mock.calls[0][0] as unknown as { where: unknown; data: Record<string, unknown> }
    expect(arg.where).toEqual({ email: "race@x.com" })
    expect(arg.data).toMatchObject({ role: "admin" })
  })

  it("other upsert errors still surface", async () => {
    upsert.mockRejectedValueOnce(new Error("disk I/O error"))
    await expect(signInFromAgentHub("a@x.com")).rejects.toThrow(/disk/)
  })

  it("a locked MidHub user is refused even though AgentHub says admin", async () => {
    findUnique.mockResolvedValue({ lockedAt: new Date(Date.now() - 24 * 3600_000) })
    await expect(signInFromAgentHub("a@x.com")).rejects.toMatchObject({ code: "account_locked" })
    expect(upsert).not.toHaveBeenCalled()
  })
})
