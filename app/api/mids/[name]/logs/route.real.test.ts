import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/helpers", () => ({ requireUser: vi.fn(async () => ({ userId: "u1" })) }))
vi.mock("@/lib/mids/registry", () => ({ getMid: vi.fn(async () => ({})) }))
vi.mock("@/lib/db/client", () => ({ prisma: {} }))
vi.mock("@/lib/mids/status", () => ({ readServiceStatus: async () => ({}), runSystemctl: async () => ({ code: 0, stdout: "" }) }))

let root: string
let logs: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "midhub-logroute-")))
  process.env.MIDHUB_ROOT = root
  logs = path.join(root, "mids", "m1", "agent", "logs")
  fs.mkdirSync(logs, { recursive: true })
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.MIDHUB_ROOT })

const ctx = { params: Promise.resolve({ name: "m1" }) }
const get = (ac = new AbortController()) => import("./route").then((m) => m.GET(new Request("http://x/api/mids/m1/logs?file=main", { signal: ac.signal }), ctx))

it("FIFO at the log path -> 4xx, not a 200 stream", async () => {
  execFileSync("mkfifo", [path.join(logs, "agent0.log.0")])
  const res = await get()
  expect(res.status).toBe(400)
  expect((await res.json()).code).toBe("invalid_request")
})

it("symlink at the log path -> 4xx", async () => {
  fs.symlinkSync("/etc/hostname", path.join(logs, "agent0.log.0"))
  expect((await get()).status).toBeGreaterThanOrEqual(400)
})

it("missing log file stays a 200 stream (status event)", async () => {
  const ac = new AbortController()
  const res = await get(ac)
  expect(res.status).toBe(200)
  ac.abort()
  await res.body!.cancel().catch(() => {})
})
