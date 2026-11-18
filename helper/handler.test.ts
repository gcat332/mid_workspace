import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleRequest, type HandlerDeps } from "./handler"
import type { Systemctl } from "./systemctl"

let tmp: string
let calls: string[][]
let execCalls: { file: string; args: string[] }[]
let active: Set<string>

function fakeSystemctl(): Systemctl {
  return {
    async run(args) {
      calls.push(args)
      await new Promise((r) => setTimeout(r, 5))
      if (args[0] === "start" || args[0] === "restart") active.add(args[1])
      if (args[0] === "stop") active.delete(args[1])
      return { code: 0, stdout: "" }
    },
    async activeMidUnits() {
      await new Promise((r) => setTimeout(r, 5))
      return [...active]
    },
  }
}

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    systemctl: fakeSystemctl(),
    exec: async (file, args) => {
      execCalls.push({ file, args })
      return { code: 0, stdout: "" }
    },
    maxRunning: 4,
    midhubRoot: path.join(tmp, "root"),
    systemdDir: path.join(tmp, "systemd"),
    ...over,
  }
}

const install = (...names: string[]) =>
  names.forEach((n) => fs.writeFileSync(path.join(tmp, "systemd", `midhub-mid-${n}.service`), "x"))
const setActive = (...names: string[]) => (active = new Set(names.map((n) => `midhub-mid-${n}.service`)))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helper-"))
  fs.mkdirSync(path.join(tmp, "systemd"))
  fs.mkdirSync(path.join(tmp, "root", "mids"), { recursive: true })
  calls = []
  execCalls = []
  active = new Set()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe("validation", () => {
  it("rejects unknown op, bad shapes, extra fields, non-string name", async () => {
    for (const req of [{ op: "rm", name: "abc" }, null, "x", [], { name: "abc" }, { op: "start", name: "abc", extra: 1 }, { op: "start", name: 5 }, { op: "start" }, { op: "installUnit", name: "abc", heapMb: 1024, x: 1 }]) {
      const r = await handleRequest(req, deps())
      expect(r).toMatchObject({ ok: false, code: "invalid_request" })
    }
    expect(calls).toEqual([])
  })
  it("rejects bad names", async () => {
    for (const name of ["../x", "A", "a", "-ab", "a b"]) expect(await handleRequest({ op: "start", name }, deps())).toMatchObject({ ok: false, code: "invalid_name" })
  })
  it("rejects heapMb outside 256-8192 or non-integer", async () => {
    for (const heapMb of [100, 70000, 1024.5, "1024", null]) {
      expect(await handleRequest({ op: "installUnit", name: "abc", heapMb }, deps())).toMatchObject({ ok: false, code: "invalid_request" })
    }
    expect(fs.readdirSync(path.join(tmp, "systemd"))).toEqual([])
  })
})

describe("quota", () => {
  it("4 active + start -> quota_full, no start call", async () => {
    install("eee")
    setActive("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "start", name: "eee" }, deps())).toMatchObject({ ok: false, code: "quota_full" })
    expect(calls.some((c) => c[0] === "start")).toBe(false)
  })
  it("3 active + two concurrent starts -> exactly one ok", async () => {
    install("eee", "fff")
    setActive("aaa", "bbb", "ccc")
    const rs = await Promise.all([handleRequest({ op: "start", name: "eee" }, deps()), handleRequest({ op: "start", name: "fff" }, deps())])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok && r.code === "quota_full")).toHaveLength(1)
  })
  it("restart of an active unit with 4 running -> ok", async () => {
    install("aaa")
    setActive("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "restart", name: "aaa" }, deps())).toEqual({ ok: true })
  })
  it("restart of an inactive unit at the cap -> quota_full", async () => {
    install("eee")
    setActive("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "restart", name: "eee" }, deps())).toMatchObject({ ok: false, code: "quota_full" })
  })
  it("start of an already-active unit at the cap -> ok without systemctl start", async () => {
    install("aaa")
    setActive("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "start", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(calls).toEqual([])
  })
})

describe("operations", () => {
  it("start = enable then start", async () => {
    install("aaa")
    await handleRequest({ op: "start", name: "aaa" }, deps())
    expect(calls).toEqual([["enable", "midhub-mid-aaa.service"], ["start", "midhub-mid-aaa.service"]])
  })
  it("stop = disable then stop", async () => {
    install("aaa")
    await handleRequest({ op: "stop", name: "aaa" }, deps())
    expect(calls).toEqual([["disable", "midhub-mid-aaa.service"], ["stop", "midhub-mid-aaa.service"]])
  })
  it("start of an uninstalled unit -> not_found", async () => {
    expect(await handleRequest({ op: "start", name: "zzz" }, deps())).toMatchObject({ ok: false, code: "not_found" })
  })
  it("systemctl failure -> systemctl_failed", async () => {
    install("aaa")
    const d = deps({ systemctl: { run: async () => ({ code: 1, stdout: "boom" }), activeMidUnits: async () => [] } })
    expect(await handleRequest({ op: "start", name: "aaa" }, d)).toMatchObject({ ok: false, code: "systemctl_failed" })
  })
  it("installUnit writes 0644 unit then daemon-reload; removeUnit deletes it", async () => {
    expect(await handleRequest({ op: "installUnit", name: "aaa", heapMb: 1024 }, deps())).toEqual({ ok: true })
    const f = path.join(tmp, "systemd", "midhub-mid-aaa.service")
    expect(fs.statSync(f).mode & 0o777).toBe(0o644)
    expect(fs.readFileSync(f, "utf8")).toContain("MemoryMax=1536M")
    expect(calls).toEqual([["daemon-reload"]])
    calls = []
    expect(await handleRequest({ op: "removeUnit", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(fs.existsSync(f)).toBe(false)
    expect(calls).toEqual([["stop", "midhub-mid-aaa.service"], ["disable", "midhub-mid-aaa.service"], ["daemon-reload"]])
  })
})

describe("fixOwnership", () => {
  it("chowns and chmods a real MID dir", async () => {
    const dir = path.join(tmp, "root", "mids", "aaa")
    fs.mkdirSync(dir)
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(execCalls).toEqual([
      { file: "chown", args: ["-R", "-P", "-h", "midsvc:midhub", dir] },
      { file: "chmod", args: ["-R", "g+rwX", dir] },
    ])
  })
  it("refuses a symlinked MID dir", async () => {
    const target = path.join(tmp, "elsewhere")
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(tmp, "root", "mids", "aaa"))
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps())).toMatchObject({ ok: false, code: "invalid_request" })
    expect(execCalls).toEqual([])
  })
  it("refuses a symlinked mids dir", async () => {
    fs.rmSync(path.join(tmp, "root", "mids"), { recursive: true })
    fs.mkdirSync(path.join(tmp, "real", "aaa"), { recursive: true })
    fs.symlinkSync(path.join(tmp, "real"), path.join(tmp, "root", "mids"))
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps())).toMatchObject({ ok: false, code: "invalid_request" })
    expect(execCalls).toEqual([])
  })
  it("refuses when the root itself resolves elsewhere", async () => {
    fs.mkdirSync(path.join(tmp, "real", "mids", "aaa"), { recursive: true })
    fs.rmSync(path.join(tmp, "root"), { recursive: true })
    fs.symlinkSync(path.join(tmp, "real"), path.join(tmp, "root"))
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps())).toMatchObject({ ok: false, code: "invalid_request" })
    expect(execCalls).toEqual([])
  })
  it("missing dir -> not_found", async () => {
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps())).toMatchObject({ ok: false, code: "not_found" })
  })
})
