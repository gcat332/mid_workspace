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
let enabled: Set<string>

let runResult: (args: string[]) => { code: number; stdout: string }

function fakeSystemctl(): Systemctl {
  return {
    async run(args) {
      calls.push(args)
      await new Promise((r) => setTimeout(r, 5))
      if (args[0] === "start" || args[0] === "restart") active.add(args[1])
      if (args[0] === "stop") active.delete(args[1])
      if (args[0] === "enable") enabled.add(args[1])
      if (args[0] === "disable") enabled.delete(args[1])
      return runResult(args)
    },
    async activeMidUnits() {
      await new Promise((r) => setTimeout(r, 5))
      return [...active]
    },
    async enabledMidUnits() {
      return [...enabled]
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
const setEnabled = (...names: string[]) => (enabled = new Set(names.map((n) => `midhub-mid-${n}.service`)))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helper-"))
  fs.mkdirSync(path.join(tmp, "systemd"))
  fs.mkdirSync(path.join(tmp, "root", "mids"), { recursive: true })
  calls = []
  execCalls = []
  active = new Set()
  enabled = new Set()
  runResult = () => ({ code: 0, stdout: "" })
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
  it("rejects heapMb outside 256-2048 or non-integer", async () => {
    for (const heapMb of [100, 2049, 4096, 70000, 1024.5, "1024", null]) {
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
  it("4 enabled with 0 active -> start of a 5th is refused", async () => {
    install("eee")
    setEnabled("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "start", name: "eee" }, deps())).toMatchObject({ ok: false, code: "quota_full" })
    expect(calls).toEqual([])
  })
  it("restart of an enabled member of the 4 -> ok", async () => {
    install("aaa")
    setEnabled("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "restart", name: "aaa" }, deps())).toEqual({ ok: true })
  })
  it("start of an already-active unit at the cap -> ok, enable only (no start)", async () => {
    install("aaa")
    setActive("aaa", "bbb", "ccc", "ddd")
    expect(await handleRequest({ op: "start", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(calls).toEqual([["enable", "midhub-mid-aaa.service"]])
  })
})

describe("operations", () => {
  it("start = reset-failed, enable, start (a manual start always gets a fresh start-limit budget)", async () => {
    install("aaa")
    await handleRequest({ op: "start", name: "aaa" }, deps())
    expect(calls).toEqual([["reset-failed", "midhub-mid-aaa.service"], ["enable", "midhub-mid-aaa.service"], ["start", "midhub-mid-aaa.service"]])
  })
  it("restart = reset-failed, enable, restart", async () => {
    install("aaa")
    setActive("aaa")
    expect(await handleRequest({ op: "restart", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(calls).toEqual([["reset-failed", "midhub-mid-aaa.service"], ["enable", "midhub-mid-aaa.service"], ["restart", "midhub-mid-aaa.service"]])
  })
  it("a failing reset-failed (unit not failed / not loaded) does not fail start, restart or removeUnit", async () => {
    install("aaa")
    runResult = (a) => (a[0] === "reset-failed" ? { code: 1, stdout: "Failed to reset failed state of unit midhub-mid-aaa.service: Unit midhub-mid-aaa.service not loaded." } : { code: 0, stdout: "" })
    expect(await handleRequest({ op: "start", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(await handleRequest({ op: "restart", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(calls.filter((c) => c[0] === "start" || c[0] === "restart")).toHaveLength(2)
    expect(await handleRequest({ op: "removeUnit", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(fs.existsSync(path.join(tmp, "systemd", "midhub-mid-aaa.service"))).toBe(false)
    expect(calls.filter((c) => c[0] === "reset-failed")).toHaveLength(3) // attempted every time, failure ignored
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
    const d = deps({ systemctl: { run: async () => ({ code: 1, stdout: "boom" }), activeMidUnits: async () => [], enabledMidUnits: async () => [] } })
    expect(await handleRequest({ op: "start", name: "aaa" }, d)).toMatchObject({ ok: false, code: "systemctl_failed" })
  })
  it("removeUnit ignores not-loaded results", async () => {
    install("aaa")
    runResult = (a) => a[0] === "stop" ? { code: 5, stdout: "" } : a[0] === "disable" ? { code: 1, stdout: "Failed to disable unit: Unit file midhub-mid-aaa.service does not exist." } : { code: 0, stdout: "" }
    expect(await handleRequest({ op: "removeUnit", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(fs.existsSync(path.join(tmp, "systemd", "midhub-mid-aaa.service"))).toBe(false)
  })
  it("removeUnit keeps the file on any other stop/disable failure", async () => {
    install("aaa")
    runResult = (a) => (a[0] === "disable" ? { code: 1, stdout: "Access denied" } : { code: 0, stdout: "" })
    expect(await handleRequest({ op: "removeUnit", name: "aaa" }, deps())).toMatchObject({ ok: false, code: "systemctl_failed" })
    expect(fs.existsSync(path.join(tmp, "systemd", "midhub-mid-aaa.service"))).toBe(true)
    expect(calls.some((c) => c[0] === "daemon-reload")).toBe(false)
  })
  it("non-MidError failures map to internal", async () => {
    const d = deps({ systemctl: { run: async () => ({ code: 0, stdout: "" }), activeMidUnits: async () => { throw new Error("x") }, enabledMidUnits: async () => [] } })
    install("aaa")
    expect(await handleRequest({ op: "start", name: "aaa" }, d)).toMatchObject({ ok: false, code: "internal" })
  })
  it("installUnit writes 0644 unit then daemon-reload; removeUnit deletes it", async () => {
    expect(await handleRequest({ op: "installUnit", name: "aaa", heapMb: 1024 }, deps())).toEqual({ ok: true })
    const f = path.join(tmp, "systemd", "midhub-mid-aaa.service")
    expect(fs.statSync(f).mode & 0o777).toBe(0o644)
    expect(fs.readFileSync(f, "utf8")).toContain("MemoryMax=1536M")
    expect(calls).toEqual([["daemon-reload"]])
    expect(fs.readdirSync(path.join(tmp, "systemd"))).toEqual(["midhub-mid-aaa.service"]) // no temp file left
    calls = []
    expect(await handleRequest({ op: "removeUnit", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(fs.existsSync(f)).toBe(false)
    // reset-failed after stop/disable: a failed unit's start-limit state must not leak into a re-install of the name.
    expect(calls).toEqual([["stop", "midhub-mid-aaa.service"], ["disable", "midhub-mid-aaa.service"], ["reset-failed", "midhub-mid-aaa.service"], ["daemon-reload"]])
  })
})

describe("fixOwnership", () => {
  it("chowns and chmods a real MID dir", async () => {
    const dir = path.join(tmp, "root", "mids", "aaa")
    fs.mkdirSync(dir)
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps())).toEqual({ ok: true })
    expect(execCalls).toEqual([
      { file: "/usr/bin/chown", args: ["-R", "-P", "-h", "midsvc:midhub", dir] },
      { file: "/usr/bin/setpriv", args: ["--reuid=midsvc", "--regid=midhub", "--clear-groups", "/usr/bin/chmod", "-R", "g+rwX", "--", dir] },
    ])
  })
  it("reports a chown failure as fix_ownership_failed with bounded detail", async () => {
    fs.mkdirSync(path.join(tmp, "root", "mids", "aaa"))
    const r = await handleRequest({ op: "fixOwnership", name: "aaa" }, deps({ exec: async () => ({ code: 1, stdout: "x".repeat(2000) }) }))
    expect(r).toMatchObject({ ok: false, code: "fix_ownership_failed" })
    const msg = (r as { message: string }).message
    expect(msg).toContain("chown")
    expect(msg.length).toBeLessThanOrEqual(300)
  })
  it("reports a chmod failure with command and stderr tail", async () => {
    fs.mkdirSync(path.join(tmp, "root", "mids", "aaa"))
    const exec = async (file: string) => (file.endsWith("setpriv") ? { code: 1, stdout: "chmod: changing permissions of 'f': Operation not permitted\n" } : { code: 0, stdout: "" })
    const r = await handleRequest({ op: "fixOwnership", name: "aaa" }, deps({ exec }))
    expect(r).toMatchObject({ ok: false, code: "fix_ownership_failed" })
    expect((r as { message: string }).message).toMatch(/chmod.*Operation not permitted/)
  })
  it("tolerates chmod failing only on vanished files", async () => {
    fs.mkdirSync(path.join(tmp, "root", "mids", "aaa"))
    const exec = async (file: string) =>
      file.endsWith("setpriv") ? { code: 1, stdout: "chmod: cannot access 'a/b': No such file or directory\nchmod: cannot access 'c': No such file or directory\n" } : { code: 0, stdout: "" }
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps({ exec }))).toEqual({ ok: true })
  })
  it.each([
    ["setpriv exit 127", 127, "setpriv: failed to execute /usr/bin/chmod: No such file or directory\n"],
    ["fts_read failed", 1, "chmod: fts_read failed: No such file or directory\n"],
    ["empty stderr, exit 1", 1, ""],
    ["tolerated + other", 1, "chmod: cannot access 'x': No such file or directory\nchmod: changing permissions of 'x': Operation not permitted\n"],
  ])("does not tolerate chmod failure: %s", async (_n, code, stdout) => {
    fs.mkdirSync(path.join(tmp, "root", "mids", "aaa"))
    const exec = async (file: string) => (file.endsWith("setpriv") ? { code, stdout } : { code: 0, stdout: "" })
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps({ exec }))).toMatchObject({ ok: false, code: "fix_ownership_failed" })
  })
  it("tolerates cannot read directory ENOENT lines", async () => {
    fs.mkdirSync(path.join(tmp, "root", "mids", "aaa"))
    const exec = async (file: string) =>
      file.endsWith("setpriv") ? { code: 1, stdout: "chmod: cannot read directory 'd': No such file or directory\n" } : { code: 0, stdout: "" }
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps({ exec }))).toEqual({ ok: true })
  })
  it("does not tolerate mixed ENOENT and other chmod errors", async () => {
    fs.mkdirSync(path.join(tmp, "root", "mids", "aaa"))
    const exec = async (file: string) =>
      file.endsWith("setpriv") ? { code: 1, stdout: "chmod: cannot access 'a': No such file or directory\nchmod: changing permissions of 'b': Operation not permitted\n" } : { code: 0, stdout: "" }
    expect(await handleRequest({ op: "fixOwnership", name: "aaa" }, deps({ exec }))).toMatchObject({ ok: false, code: "fix_ownership_failed" })
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

describe("bounded queue", () => {
  it("more than 32 pending -> busy", async () => {
    install("aaa")
    const rs = await Promise.all(Array.from({ length: 40 }, () => handleRequest({ op: "stop", name: "aaa" }, deps())))
    expect(rs.filter((r) => !r.ok && r.code === "busy").length).toBe(8)
    expect(rs.filter((r) => r.ok).length).toBe(32)
  })
})
