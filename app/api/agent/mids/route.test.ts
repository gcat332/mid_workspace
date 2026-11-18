import { beforeEach, expect, it, vi } from "vitest"

const audit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
const reg = vi.hoisted(() => ({ listMids: vi.fn() }))
vi.mock("@/lib/mids/registry", () => reg)
const A = "https://a.service-now.com/"
vi.mock("@/lib/agent/auth", () => ({
  authenticateAgent: async () => ({
    user: { userId: "u1", email: "u@x.com", role: "member", authAt: 0 }, taskId: "t1", sessionInstances: ["https://a.service-now.com/"],
  }),
}))

import { GET } from "./route"

const mid = (name: string, o: object = {}) => ({
  name, instanceUrl: A, configUrl: A, midName: `sn-${name}`, heapMb: 1, version: null, state: "installed",
  agentAccess: true, status: { state: "running", pid: 1, memoryBytes: 1, since: null }, job: null, ...o,
})

beforeEach(() => audit.mockClear())

it("lists MIDs with checks and usable, without auditing", async () => {
  reg.listMids.mockResolvedValue([
    mid("ok1"),
    mid("off", { agentAccess: false, status: { state: "stopped", pid: null, memoryBytes: null, since: null } }),
    mid("busy", { job: { id: "j", kind: "install", stage: "extract", status: "running", createdAt: new Date() } }),
    mid("other", { instanceUrl: "https://b.service-now.com/", configUrl: "https://b.service-now.com/" }),
  ])
  const res = await GET(new Request("http://127.0.0.1/api/agent/mids"), undefined)
  expect(res.status).toBe(200)
  const { mids } = await res.json()
  expect(mids.map((m: { name: string; usable: boolean }) => [m.name, m.usable])).toEqual([
    ["ok1", true], ["off", false], ["busy", false], ["other", false],
  ])
  expect(mids[0]).toMatchObject({ snName: "sn-ok1", instanceUrl: A, status: "กำลังรัน" })
  expect(mids[0].checks).toHaveLength(5)
  expect(mids[1].status).toBe("หยุด")
  expect(mids[2].checks.find((c: { id: string }) => c.id === "mid_ready").ok).toBe(false)
  expect(audit).not.toHaveBeenCalled()
})
