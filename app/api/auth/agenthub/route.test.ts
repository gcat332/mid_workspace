import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { MidError } from "@/lib/mids/names"
import { verifyToken } from "@/lib/auth/jwt"

type Lookup = { ok: true; email: string } | { ok: false; reason: "signed_out" | "not_admin" | "unreachable" }
const lookupAgentHubAdmin = vi.hoisted(() => vi.fn<(c: string | undefined) => Promise<Lookup>>(async () => ({ ok: false, reason: "signed_out" })))
const signInFromAgentHub = vi.hoisted(() => vi.fn(async (email: string) => {
  const now = Math.floor(Date.now() / 1000)
  return { userId: "u1", email, role: "admin" as const, authAt: now, ahAt: now }
}))
vi.mock("@/lib/auth/agenthub", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/agenthub")>()),
  lookupAgentHubAdmin,
  signInFromAgentHub,
}))
const recordAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit }))
const auditDenied = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/auth/denial-audit", () => ({ auditDenied }))

import { GET } from "./route"

const AH = "ah-cookie-value-123"
const req = (qs = "", cookie: string | null = `session=${AH}`) =>
  new NextRequest(`http://localhost:3100/midhub/api/auth/agenthub${qs}`, {
    headers: cookie ? { cookie, "x-forwarded-for": "10.0.0.7" } : { "x-forwarded-for": "10.0.0.7" },
    nextConfig: { basePath: "/midhub" },
  } as ConstructorParameters<typeof NextRequest>[1])

beforeEach(() => {
  lookupAgentHubAdmin.mockReset()
  signInFromAgentHub.mockClear()
  recordAudit.mockClear(); auditDenied.mockClear()
})

const sessionFrom = (res: Response) => /midhub_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1]

it("admin: sets midhub_session (with ahAt), audits auth.login via agenthub, 303 to next", async () => {
  lookupAgentHubAdmin.mockResolvedValue({ ok: true, email: "boss@x.com" })
  const res = await GET(req("?next=" + encodeURIComponent("/mids/abc?tab=logs")))
  expect(lookupAgentHubAdmin).toHaveBeenCalledWith(AH)
  expect(signInFromAgentHub).toHaveBeenCalledWith("boss@x.com")
  expect(res.status).toBe(303)
  expect(res.headers.get("location")).toBe("/midhub/mids/abc?tab=logs")
  const tok = sessionFrom(res)
  expect(tok).toBeTruthy()
  const p = await verifyToken(tok!)
  expect(p).toMatchObject({ userId: "u1", email: "boss@x.com", role: "admin" })
  expect(typeof p!.ahAt).toBe("number")
  expect(res.headers.get("set-cookie")).toContain("Path=/midhub")
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ email: "boss@x.com" }), "auth.login", undefined, { via: "agenthub" })
})

it("no next / next = '/' -> the app root /midhub", async () => {
  lookupAgentHubAdmin.mockResolvedValue({ ok: true, email: "boss@x.com" })
  expect((await GET(req())).headers.get("location")).toBe("/midhub")
  expect((await GET(req("?next=%2F"))).headers.get("location")).toBe("/midhub")
})

it.each(["//evil.com", "/\\evil.com", "https://evil.com", "evil", "/a/../../x", "/a\r\nSet-Cookie:x", "/a\u0000b"])(
  "an unsafe next (%s) falls back to /midhub", async (n) => {
    lookupAgentHubAdmin.mockResolvedValue({ ok: true, email: "boss@x.com" })
    const res = await GET(req("?next=" + encodeURIComponent(n)))
    expect(res.headers.get("location")).toBe("/midhub")
  })

it.each(["signed_out", "not_admin", "unreachable"] as const)("%s -> 303 to the access page with that reason, no session", async (reason) => {
  lookupAgentHubAdmin.mockResolvedValue({ ok: false, reason })
  const res = await GET(req("?next=%2Fmids"))
  expect(res.status).toBe(303)
  expect(res.headers.get("location")).toBe(`/midhub/login?reason=${reason}`)
  expect(sessionFrom(res) ?? "").toBe("") // nothing issued (a stale one is cleared)
  expect(signInFromAgentHub).not.toHaveBeenCalled()
  expect(auditDenied).toHaveBeenCalledWith(reason, expect.objectContaining({ ip: "10.0.0.7" }))
  expect(recordAudit).not.toHaveBeenCalled()
})

it("no AgentHub cookie: the lookup gets undefined (signed_out)", async () => {
  lookupAgentHubAdmin.mockResolvedValue({ ok: false, reason: "signed_out" })
  const res = await GET(req("", null))
  expect(lookupAgentHubAdmin).toHaveBeenCalledWith(undefined)
  expect(res.headers.get("location")).toBe("/midhub/login?reason=signed_out")
})

it("locked MidHub user -> access page reason=locked, no session", async () => {
  lookupAgentHubAdmin.mockResolvedValue({ ok: true, email: "boss@x.com" })
  signInFromAgentHub.mockRejectedValueOnce(new MidError("account_locked"))
  const res = await GET(req())
  expect(res.headers.get("location")).toBe("/midhub/login?reason=locked")
  expect(sessionFrom(res) ?? "").toBe("")
  expect(auditDenied).toHaveBeenCalledWith("locked", expect.objectContaining({ email: "boss@x.com" }))
})

it("never echoes the AgentHub cookie value", async () => {
  for (const r of [{ ok: true as const, email: "boss@x.com" }, { ok: false as const, reason: "unreachable" as const }]) {
    lookupAgentHubAdmin.mockResolvedValue(r)
    const res = await GET(req())
    const all = JSON.stringify([...res.headers.entries()]) + (await res.text())
    expect(all).not.toContain(AH)
  }
  expect(JSON.stringify(auditDenied.mock.calls) + JSON.stringify(recordAudit.mock.calls)).not.toContain(AH)
})
