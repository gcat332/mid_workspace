import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sock = vi.hoisted(() => ({ path: "" }))
vi.mock("@/lib/env", () => ({ env: { get helperSocket() { return sock.path } } }))
import { callHelper } from "./client"

let dir: string
let server: net.Server | undefined
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-"))
  sock.path = path.join(dir, "h.sock")
})
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)))
  server = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

function serve(reply: string) {
  server = net.createServer((c) => {
    c.once("data", () => c.end(reply + "\n"))
  })
  return new Promise<void>((r) => server!.listen(sock.path, r))
}

describe("callHelper", () => {
  it("missing socket -> helper_down 503", async () => {
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ name: "MidError", code: "helper_down", status: 503 })
  })
  it("ok response", async () => {
    await serve('{"ok":true}')
    await expect(callHelper({ op: "start", name: "abc" })).resolves.toEqual({ ok: true })
  })
  it("maps quota_full", async () => {
    await serve('{"ok":false,"code":"quota_full","message":"x"}')
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "quota_full", status: 409 })
  })
  it("maps systemctl_failed with helper message", async () => {
    await serve('{"ok":false,"code":"systemctl_failed","message":"boom"}')
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "systemctl_failed", message: "boom" })
  })
  it("garbage reply -> helper_down", async () => {
    await serve("nope")
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "helper_down" })
  })
})
