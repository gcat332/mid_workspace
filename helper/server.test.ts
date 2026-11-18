import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHelperServer } from "./server"
import type { HandlerDeps } from "./handler"

let dir: string
let server: net.Server
let sockPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"))
  fs.mkdirSync(path.join(dir, "systemd"))
  fs.writeFileSync(path.join(dir, "systemd", "midhub-mid-aaa.service"), "x")
  sockPath = path.join(dir, "h.sock")
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

function start(runDelayMs: number, readDeadlineMs: number) {
  const deps: HandlerDeps = {
    systemctl: {
      run: async () => {
        await new Promise((r) => setTimeout(r, runDelayMs))
        return { code: 0, stdout: "" }
      },
      activeMidUnits: async () => [],
      enabledMidUnits: async () => [],
    },
    exec: async () => ({ code: 0, stdout: "" }),
    maxRunning: 4,
    midhubRoot: path.join(dir, "root"),
    systemdDir: path.join(dir, "systemd"),
  }
  server = createHelperServer(deps, { readDeadlineMs })
  return new Promise<void>((r) => server.listen(sockPath, r))
}

function ask(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sockPath)
    let out = ""
    c.setEncoding("utf8")
    c.on("data", (d: string) => (out += d))
    c.on("close", () => resolve(out))
    c.on("error", reject)
    c.write(payload)
  })
}

describe("helper server", () => {
  it("delivers the reply of a handler slower than the read deadline", async () => {
    await start(300, 100)
    expect(JSON.parse(await ask('{"op":"stop","name":"aaa"}\n'))).toEqual({ ok: true })
  })
  it("drops a connection that never finishes its line (absolute deadline)", async () => {
    await start(0, 100)
    const t = Date.now()
    const c = net.connect(sockPath)
    await new Promise((r) => {
      c.on("connect", () => c.write("{"))
      c.on("close", r)
      c.on("error", () => {})
    })
    expect(Date.now() - t).toBeLessThan(1500)
  })
  it("rejects malformed JSON and oversized lines", async () => {
    await start(0, 1000)
    expect(JSON.parse(await ask("not json\n"))).toMatchObject({ ok: false, code: "invalid_request" })
    expect(JSON.parse(await ask("a".repeat(5000)))).toMatchObject({ ok: false, code: "invalid_request" })
  })
  it("caps connections at 16", async () => {
    await start(0, 1000)
    expect(server.maxConnections).toBe(16)
  })
})
