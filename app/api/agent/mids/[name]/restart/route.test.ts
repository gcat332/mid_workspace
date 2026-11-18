import { beforeEach, expect, it, vi } from "vitest"

const SECRET = "Rs8-restart-route-agent-secret-" + "s".repeat(20)
vi.mock("@/lib/env", () => ({ env: { agentSecret: "Rs8-restart-route-agent-secret-" + "s".repeat(20) } }))
vi.mock("@/lib/db/client", () => ({
  prisma: { user: { findUnique: async () => ({ id: "u1", email: "alice@x.com", role: "member", lockedAt: null }) } },
}))
const audit = vi.hoisted(() => vi.fn(async (...a: unknown[]) => void a))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
const callHelper = vi.hoisted(() => vi.fn())
vi.mock("@/lib/helper/client", () => ({ callHelper }))
const readHostMemory = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mids/status", () => ({ readHostMemory }))
const reg = vi.hoisted(() => ({ agentAccess: true, state: "running", getMid: vi.fn() }))
vi.mock("@/lib/mids/registry", async () => {
  const { MidError } = await import("@/lib/mids/names")
  reg.getMid.mockImplementation(async (name: string) => {
    if (name !== "m1") throw new MidError("not_found")
    return {
      name, instanceUrl: "https://a.service-now.com/", configUrl: "https://a.service-now.com/", midName: "sn", heapMb: 1, version: null,
      state: "installed", agentAccess: reg.agentAccess, status: { state: reg.state, pid: 1, memoryBytes: 1, since: null }, job: null,
    }
  })
  return { getMid: reg.getMid }
})

import { MidError } from "@/lib/mids/names"
import { POST } from "./route"

const GIB = 1024 ** 3
const A = "https://a.service-now.com/"
const H: Record<string, string> = {
  host: "127.0.0.1:3100",
  "x-midhub-agent-secret": SECRET,
  "x-midhub-actor-email": "alice@x.com",
  "x-midhub-session-id": "task-9",
  "x-midhub-session-instances": A,
}
const ctx = (name = "m1") => ({ params: Promise.resolve({ name }) })
const post = (body?: unknown, name = "m1") =>
  POST(new Request(`http://127.0.0.1:3100/midhub/api/agent/mids/${name}/restart`, {
    method: "POST", headers: { ...H, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), ctx(name))
const base = { via: "agenthub", taskId: "task-9", sessionInstances: [A] }

beforeEach(() => {
  reg.agentAccess = true
  reg.state = "running"
  for (const f of [audit, callHelper, readHostMemory]) f.mockReset()
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: 4 * GIB })
  callHelper.mockResolvedValue({ ok: true })
})

it("agentAccess off -> 403 agent_check_failed, helper never called", async () => {
  reg.agentAccess = false
  const res = await post()
  expect(res.status).toBe(403)
  expect((await res.json()).code).toBe("agent_check_failed")
  expect(callHelper).not.toHaveBeenCalled()
  expect(audit.mock.calls.map((c) => c[1])).toEqual(["agent.check_failed"])
})

it("running MID: helper restart, audited agent.restart with via/taskId and never the secret", async () => {
  const res = await post()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(callHelper).toHaveBeenCalledWith({ op: "restart", name: "m1" })
  expect(readHostMemory).not.toHaveBeenCalled()
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ email: "alice@x.com" }), "agent.restart", "m1", base)
  expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET)
})

it("stopped MID with low RAM -> 409 low_memory (a confirm flag from the agent is ignored), helper not called", async () => {
  reg.state = "stopped"
  readHostMemory.mockResolvedValue({ totalBytes: 8 * GIB, availableBytes: 0.5 * GIB })
  for (const body of [undefined, { confirmLowMemory: true }]) {
    const res = await post(body)
    expect(res.status).toBe(409)
    const b = await res.json()
    expect(b.code).toBe("low_memory")
    expect(b.availableBytes).toBe(0.5 * GIB)
    expect(b.message).toContain("0.5 GB")
  }
  expect(callHelper).not.toHaveBeenCalled()
})

it("stopped MID with enough RAM -> helper restart (= start)", async () => {
  reg.state = "failed"
  expect((await post()).status).toBe(200)
  expect(readHostMemory).toHaveBeenCalled()
  expect(callHelper).toHaveBeenCalledWith({ op: "restart", name: "m1" })
})

it("helper quota_full is returned as-is and audited as a failed attempt", async () => {
  reg.state = "stopped"
  callHelper.mockRejectedValueOnce(new MidError("quota_full"))
  const res = await post()
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe("quota_full")
  expect(audit).toHaveBeenLastCalledWith(expect.anything(), "agent.restart", "m1", { ...base, ok: false, code: "quota_full" })
})

it("invalid MID name -> 400 invalid_name, no helper", async () => {
  const res = await post(undefined, "Bad_Name")
  expect((await res.json()).code).toBe("invalid_name")
  expect(callHelper).not.toHaveBeenCalled()
})
