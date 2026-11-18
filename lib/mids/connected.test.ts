import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db/client", () => ({
  prisma: { job: { findFirst: async () => null }, midServer: { findUnique: async ({ where }: { where: { name: string } }) => ({ name: where.name, state: "installed" }) } },
}))
vi.mock("@/lib/mids/status", () => ({ readServiceStatus: async () => ({ state: "inactive", pid: null, memoryBytes: null, since: null }), runSystemctl: async () => ({ code: 0, stdout: "" }) }))

import { parseLineTime, waitConnected } from "./connected"
import { CONNECTED_MARKER } from "./layout"

let root: string
let logDir: string
let log: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-conn-"))
  process.env.MIDHUB_ROOT = root
  logDir = path.join(root, "mids", "m1", "agent", "logs")
  fs.mkdirSync(path.join(root, "mids", "m1", "agent", "conf"), { recursive: true })
  fs.writeFileSync(path.join(root, "mids", "m1", "agent", "config.xml"), "<parameters/>")
  fs.mkdirSync(logDir, { recursive: true })
  log = path.join(logDir, "agent0.log.0")
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

const since = new Date("2026-11-18T15:40:00.000Z") // 22:40:00+0700
const line = (ts: string, msg: string) => `${ts} (main) ${msg}\n`

describe("waitConnected", () => {
  it("parses +0700 offsets", () => {
    expect(parseLineTime("2026-11-18T22:40:42.895+0700 x")).toBe(Date.parse("2026-11-18T15:40:42.895Z"))
    expect(parseLineTime("no timestamp")).toBeNull()
  })

  it("ignores an old marker and resolves on a new one", async () => {
    fs.writeFileSync(log, line("2026-11-18T22:30:00.000+0700", CONNECTED_MARKER + " old"))
    let done = false
    const p = waitConnected("m1", since, { pollMs: 20, timeoutMs: 5000 }).then(() => (done = true))
    await new Promise((r) => setTimeout(r, 150))
    expect(done).toBe(false)
    fs.appendFileSync(log, "continuation without timestamp " + CONNECTED_MARKER + "\n")
    await new Promise((r) => setTimeout(r, 100))
    expect(done).toBe(false)
    fs.appendFileSync(log, line("2026-11-18T22:40:42.895+0700", CONNECTED_MARKER + " x"))
    await p
    expect(done).toBe(true)
  })

  it("times out with sanitised ERROR lines as detail (max 20)", async () => {
    let body = ""
    for (let i = 0; i < 25; i++) body += line("2026-11-18T22:41:00.000+0700", `ERROR bad ${i}\u0007${"x".repeat(400)}`)
    body += line("2026-11-18T22:41:00.000+0700", "INFO fine")
    fs.writeFileSync(log, body)
    const err = await waitConnected("m1", since, { pollMs: 20, timeoutMs: 300 }).catch((e) => e)
    expect(err).toMatchObject({ code: "connect_timeout", status: 504 })
    const lines = (err.detail as string).split("\n")
    expect(lines).toHaveLength(20)
    expect(lines[19]).toContain("bad 24")
    expect(lines[0]).toContain("bad 5")
    expect(lines.every((l: string) => l.length <= 300 && !l.includes("\u0007"))).toBe(true)
  })

  it("works when the log appears after the call", async () => {
    const p = waitConnected("m1", since, { pollMs: 20, timeoutMs: 5000 })
    await new Promise((r) => setTimeout(r, 100))
    fs.writeFileSync(log, line("2026-11-18T22:40:42.895+0700", CONNECTED_MARKER))
    await p
  })

  it("honours the abort signal", async () => {
    const ac = new AbortController()
    const p = waitConnected("m1", since, { pollMs: 20, timeoutMs: 5000, signal: ac.signal })
    setTimeout(() => ac.abort(new Error("stop")), 80)
    await expect(p).rejects.toThrow("stop")
  })
})
