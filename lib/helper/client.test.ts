import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sock = vi.hoisted(() => ({ path: "" }))
vi.mock("@/lib/env", () => ({ env: { get helperSocket() { return sock.path }, maxRunning: 3 } }))
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
  it("missing socket -> helper_down 503 with the shared message and a next step in detail (M5/Q-M15)", async () => {
    const { MidError } = await import("@/lib/mids/names")
    const e = await callHelper({ op: "start", name: "abc" }).catch((x) => x)
    expect(e).toMatchObject({ name: "MidError", code: "helper_down", status: 503, message: new MidError("helper_down").message })
    expect(e.message).not.toContain("แจ้ง Admin")
    expect(e.detail).toContain("systemctl status bsm-midhub-helper")
  })
  it("ECONNREFUSED (non-socket file) and EACCES -> helper_down", async () => {
    fs.writeFileSync(sock.path, "")
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "helper_down", status: 503 })
    fs.rmSync(sock.path)
    await serve('{"ok":true}')
    fs.chmodSync(sock.path, 0o000)
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "helper_down", status: 503 })
  })
  it("ok response", async () => {
    await serve('{"ok":true}')
    await expect(callHelper({ op: "start", name: "abc" })).resolves.toEqual({ ok: true })
  })
  it("maps quota_full", async () => {
    await serve('{"ok":false,"code":"quota_full","message":"x"}')
    // The number comes from MIDHUB_MAX_RUNNING, not a literal 4 (M4).
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "quota_full", status: 409, message: "รันครบ 3 ตัวแล้ว ให้หยุดตัวอื่นก่อน" })
  })
  it("maps systemctl_failed with helper message", async () => {
    await serve('{"ok":false,"code":"systemctl_failed","message":"boom"}')
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "systemctl_failed", message: "สั่ง systemd ไม่สำเร็จ ดูรายละเอียดด้านล่าง หรือแจ้ง Admin", detail: "boom" })
  })
  it("garbage or wrong-shape reply -> helper_down with detail", async () => {
    for (const bad of ["nope", '{"ok":false}', '{"ok":"yes"}']) {
      await serve(bad)
      await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "helper_down", detail: expect.stringContaining("malformed") })
      await new Promise((r) => server!.close(r))
    }
  })
  it("unknown code -> internal", async () => {
    await serve('{"ok":false,"code":"weird","message":"m"}')
    await expect(callHelper({ op: "start", name: "abc" })).rejects.toMatchObject({ code: "internal", detail: "m" })
  })
})
