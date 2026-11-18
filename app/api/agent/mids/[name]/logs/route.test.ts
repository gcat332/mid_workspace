import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const SECRET = "Lg5-logs-route-agent-secret-" + "s".repeat(20)
vi.mock("@/lib/env", () => ({ env: { agentSecret: "Lg5-logs-route-agent-secret-" + "s".repeat(20) } }))
vi.mock("@/lib/db/client", () => ({
  prisma: { user: { findUnique: async () => ({ id: "u1", email: "alice@x.com", role: "member", lockedAt: null }) } },
}))
const audit = vi.hoisted(() => vi.fn(async (...a: unknown[]) => void a))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
const reg = vi.hoisted(() => ({ agentAccess: true, getMid: vi.fn() }))
vi.mock("@/lib/mids/registry", async () => {
  const { MidError } = await import("@/lib/mids/names")
  reg.getMid.mockImplementation(async (name: string) => {
    if (name !== "m1") throw new MidError("not_found")
    return {
      name, instanceUrl: "https://a.service-now.com/", configUrl: "https://a.service-now.com/", midName: "sn", heapMb: 1, version: null,
      state: "installed", agentAccess: reg.agentAccess, status: { state: "running", pid: 1, memoryBytes: 1, since: null }, job: null,
    }
  })
  return { getMid: reg.getMid }
})

import { GET } from "./route"

const H: Record<string, string> = {
  host: "127.0.0.1:3100",
  "x-midhub-agent-secret": SECRET,
  "x-midhub-actor-email": "alice@x.com",
  "x-midhub-session-id": "task-9",
  "x-midhub-session-instances": "https://a.service-now.com/",
}
const ctx = (name = "m1") => ({ params: Promise.resolve({ name }) })
const get = (qs: string, name = "m1") => GET(new Request(`http://127.0.0.1:3100/midhub/api/agent/mids/${name}/logs${qs}`, { headers: H }), ctx(name))

let root: string
let m: string
const L = (k: number) => Array.from({ length: k }, (_, i) => `log ${i + 1}`)
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-agent-logs-"))
  process.env.MIDHUB_ROOT = root
  m = path.join(root, "mids", "m1")
  fs.mkdirSync(path.join(m, "agent/logs"), { recursive: true })
  fs.writeFileSync(path.join(m, "agent/logs/agent0.log.0"), L(3000).join("\n") + "\n")
  fs.writeFileSync(path.join(m, "agent/logs/wrapper.log"), "w1\nw2\n")
  reg.agentAccess = true
  audit.mockClear()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

it("agentAccess off -> 403 agent_check_failed (audited as check_failed), no lines", async () => {
  reg.agentAccess = false
  const res = await get("?file=main&lines=5")
  expect(res.status).toBe(403)
  const b = await res.json()
  expect(b.code).toBe("agent_check_failed")
  expect(b.lines).toBeUndefined()
  expect(audit.mock.calls.map((c) => c[1])).toEqual(["agent.check_failed"])
})

it("default 200 lines of main; reads are not audited", async () => {
  const res = await get("")
  expect(res.status).toBe(200)
  const { lines } = await res.json()
  expect(lines).toEqual(L(3000).slice(-200))
  expect(audit).not.toHaveBeenCalled()
})

it("lines=5000 is clamped to 2000; 0/negative -> 1; non-numeric -> 200", async () => {
  expect((await (await get("?lines=5000")).json()).lines).toHaveLength(2000)
  expect((await (await get("?lines=0")).json()).lines).toEqual(["log 3000"])
  expect((await (await get("?lines=-7")).json()).lines).toEqual(["log 3000"])
  expect((await (await get("?lines=abc")).json()).lines).toHaveLength(200)
  expect((await (await get("?lines=3")).json()).lines).toEqual(["log 2998", "log 2999", "log 3000"])
})

it("file=wrapper reads wrapper.log; any other file -> 400 invalid_request", async () => {
  expect(await (await get("?file=wrapper")).json()).toEqual({ lines: ["w1", "w2"] })
  for (const f of ["../config.xml", "agent/config.xml", "x", "toString"]) {
    const res = await get(`?file=${encodeURIComponent(f)}`)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  }
})

it("missing log file -> empty lines; log swapped for a symlink to config.xml is refused", async () => {
  fs.rmSync(path.join(m, "agent/logs/wrapper.log"))
  expect(await (await get("?file=wrapper")).json()).toEqual({ lines: [] })
  fs.writeFileSync(path.join(m, "agent/config.xml"), "<password>secret</password>\n")
  fs.symlinkSync(path.join(m, "agent/config.xml"), path.join(m, "agent/logs/wrapper.log"))
  const res = await get("?file=wrapper")
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(await res.text()).not.toContain("secret</password>")
})

it("invalid MID name -> 400 before any lookup", async () => {
  const res = await get("", "Bad_Name")
  expect((await res.json()).code).toBe("invalid_name")
  expect(reg.getMid).not.toHaveBeenCalledWith("Bad_Name")
})
