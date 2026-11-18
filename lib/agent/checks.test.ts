import { beforeEach, describe, expect, it, vi } from "vitest"

const audit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
const reg = vi.hoisted(() => ({ getMid: vi.fn() }))
vi.mock("@/lib/mids/registry", () => reg)

import { evaluateChecks, requireUsableMid, type MidFacts } from "./checks"
import { handleRouteError } from "@/lib/http/route"
import type { AgentCaller } from "./auth"

const A = "https://a.service-now.com/"
const B = "https://b.service-now.com/"
const caller = (sessionInstances: string[] = [A]): AgentCaller => ({
  user: { userId: "u1", email: "u@x.com", role: "member", authAt: 0 } as AgentCaller["user"],
  taskId: "t1",
  sessionInstances,
})
const good: MidFacts = { agentAccess: true, state: "installed", activeJob: null, instanceUrl: A, configUrl: A }
const failedIds = (c: AgentCaller, m: MidFacts) => evaluateChecks(c, m).filter((x) => !x.ok).map((x) => x.id)

describe("evaluateChecks", () => {
  it("all pass; fixed five-id order", () => {
    const r = evaluateChecks(caller(), good)
    expect(r.map((c) => c.id)).toEqual(["user_registered", "session_instance", "instance_match", "agent_access", "mid_ready"])
    expect(r.every((c) => c.ok)).toBe(true)
  })
  it("session_instance fails alone on empty set", () => {
    expect(failedIds(caller([]), good)).toEqual(["session_instance"])
  })
  it("instance_match fails with hosts in the message", () => {
    const r = evaluateChecks(caller([A]), { ...good, instanceUrl: B, configUrl: B })
    const c = r.find((x) => x.id === "instance_match")!
    expect(c.ok).toBe(false)
    expect(c.message).toContain("a.service-now.com")
    expect(c.message).toContain("b.service-now.com")
    expect(r.filter((x) => !x.ok)).toHaveLength(1)
  })
  it("instance url vs config url mismatch fails", () => {
    expect(failedIds(caller([A, B]), { ...good, instanceUrl: A, configUrl: B })).toEqual(["instance_match"])
  })
  it("normalises (case, trailing slash) before comparing; falls back to config url", () => {
    expect(failedIds(caller([A]), { ...good, instanceUrl: null, configUrl: "https://A.service-now.com" })).toEqual([])
  })
  it("neither url known fails", () => {
    expect(failedIds(caller(), { ...good, instanceUrl: null, configUrl: null })).toEqual(["instance_match"])
  })
  it("agent_access off fails alone", () => {
    expect(failedIds(caller(), { ...good, agentAccess: false })).toEqual(["agent_access"])
  })
  it.each(["removed", "installing", "uninstalling"])("state %s is not ready", (state) => {
    expect(failedIds(caller(), { ...good, state })).toEqual(["mid_ready"])
  })
  it("active job names its stage; stopped MID is still ready", () => {
    const c = evaluateChecks(caller(), { ...good, activeJob: "extract" }).find((x) => x.id === "mid_ready")!
    expect(c.message).toContain("extract")
    expect(failedIds(caller(), { ...good, state: "installed" })).toEqual([])
  })
})

describe("requireUsableMid", () => {
  beforeEach(() => audit.mockClear())
  const summary = (o: object = {}) => ({
    name: "m1", instanceUrl: A, configUrl: A, midName: "x", heapMb: 1, version: null, state: "installed",
    agentAccess: true, status: { state: "running", pid: 1, memoryBytes: 1, since: null }, job: null, ...o,
  })
  it("returns the MID when usable, no audit", async () => {
    reg.getMid.mockResolvedValue(summary())
    expect((await requireUsableMid(caller(), "m1")).name).toBe("m1")
    expect(audit).not.toHaveBeenCalled()
  })
  it("audits and throws 403 with checks in the body", async () => {
    reg.getMid.mockResolvedValue(summary({ agentAccess: false }))
    const err = await requireUsableMid(caller(), "m1").catch((e) => e)
    expect(audit).toHaveBeenCalledWith(caller().user, "agent.check_failed", "m1", {
      via: "agenthub", taskId: "t1", sessionInstances: [A], mid: "m1", failed: ["agent_access"],
    })
    const res = handleRouteError(err)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe("agent_check_failed")
    expect(body.message).toContain("ยังไม่เปิดให้ AgentHub")
    expect(body.checks).toHaveLength(5)
  })
})
