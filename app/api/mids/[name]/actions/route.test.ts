import { beforeEach, expect, it, vi } from "vitest"
import { MidError } from "@/lib/mids/names"

let signedIn = true
vi.mock("@/lib/auth/helpers", () => ({
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Response("{}", { status: 401 })
    return { userId: "u1", email: "a@x.com", role: "member" }
  }),
}))
const callHelper = vi.hoisted(() => vi.fn())
const readHostMemory = vi.hoisted(() => vi.fn())
const getMid = vi.hoisted(() => vi.fn())
const recordAudit = vi.hoisted(() => vi.fn())
vi.mock("@/lib/helper/client", () => ({ callHelper }))
vi.mock("@/lib/mids/status", () => ({ readHostMemory }))
vi.mock("@/lib/mids/registry", () => ({ getMid }))
vi.mock("@/lib/audit", () => ({ recordAudit }))

const GIB = 1024 ** 3
const ctx = (name = "m1") => ({ params: Promise.resolve({ name }) })
const post = (body: unknown) => new Request("http://x/api/mids/m1/actions", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
const mid = (state: string) => ({ name: "m1", status: { state } })

beforeEach(() => {
  signedIn = true
  for (const m of [callHelper, readHostMemory, getMid, recordAudit]) m.mockReset()
  getMid.mockResolvedValue(mid("stopped"))
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: 4 * GIB })
  callHelper.mockResolvedValue({ ok: true })
})

it("401 when signed out; 400 invalid_request for bad body/action/confirm type", async () => {
  const { POST } = await import("./route")
  signedIn = false
  expect((await POST(post({ action: "start" }), ctx())).status).toBe(401)
  signedIn = true
  for (const bad of ["not json", {}, { action: "delete" }, { action: "start", confirmLowMemory: "yes" }, null]) {
    const res = await POST(post(bad), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  }
  expect(callHelper).not.toHaveBeenCalled()
})

it("404 for unknown MID", async () => {
  const { POST } = await import("./route")
  getMid.mockRejectedValueOnce(new MidError("not_found"))
  expect((await POST(post({ action: "start" }), ctx("zz"))).status).toBe(404)
  expect(callHelper).not.toHaveBeenCalled()
})

it("start with < 1 GiB free and no confirm -> 409 low_memory, helper not called", async () => {
  const { POST } = await import("./route")
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: 0.5 * GIB })
  const res = await POST(post({ action: "start" }), ctx())
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body.code).toBe("low_memory")
  expect(body.availableBytes).toBe(0.5 * GIB)
  expect(body.message).toContain("0.5 GB")
  expect(callHelper).not.toHaveBeenCalled()
  expect(recordAudit).not.toHaveBeenCalled()
})

it("start with confirmLowMemory proceeds, audits with detail", async () => {
  const { POST } = await import("./route")
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: 0.5 * GIB })
  const res = await POST(post({ action: "start", confirmLowMemory: true }), ctx())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(callHelper).toHaveBeenCalledWith({ op: "start", name: "m1" })
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "mid.start", "m1", { confirmLowMemory: true })
})

it("exactly 1 GiB free is enough; success without confirm audits mid.start", async () => {
  const { POST } = await import("./route")
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: GIB })
  expect((await POST(post({ action: "start" }), ctx())).status).toBe(200)
  expect(recordAudit).toHaveBeenCalledWith(expect.anything(), "mid.start", "m1", {})
})

it("stop never checks memory; restart checks only when MID is not running/starting", async () => {
  const { POST } = await import("./route")
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: 0.1 * GIB })
  getMid.mockResolvedValue(mid("running"))
  expect((await POST(post({ action: "stop" }), ctx())).status).toBe(200)
  expect((await POST(post({ action: "restart" }), ctx())).status).toBe(200)
  getMid.mockResolvedValue(mid("starting"))
  expect((await POST(post({ action: "restart" }), ctx())).status).toBe(200)
  for (const state of ["stopped", "failed", "unknown"]) {
    getMid.mockResolvedValue(mid(state))
    expect((await POST(post({ action: "restart" }), ctx())).status).toBe(409)
  }
  expect(callHelper).toHaveBeenCalledTimes(3)
})

it("helper errors pass through handleRouteError and are audited as failures (M6)", async () => {
  const { POST } = await import("./route")
  callHelper.mockRejectedValueOnce(new MidError("quota_full"))
  const q = await POST(post({ action: "start" }), ctx())
  expect(q.status).toBe(409)
  expect(await q.json()).toMatchObject({ code: "quota_full" })
  expect(recordAudit).toHaveBeenLastCalledWith(expect.anything(), "mid.start", "m1", { ok: false, code: "quota_full" })
  callHelper.mockRejectedValueOnce(new MidError("helper_down"))
  expect((await POST(post({ action: "stop" }), ctx())).status).toBe(503)
  expect(recordAudit).toHaveBeenLastCalledWith(expect.anything(), "mid.stop", "m1", { ok: false, code: "helper_down" })
})
