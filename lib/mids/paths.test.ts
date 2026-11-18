import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const h = vi.hoisted(() => ({ root: "" }))
vi.mock("@/lib/env", () => ({
  env: {
    get midhubRoot() {
      return h.root
    },
  },
}))

import { resolveMidPath, isReadOnlyPath } from "./paths"
import { midRoot } from "./names"

let outside: string
beforeAll(() => {
  h.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "midhub-paths-")))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-outside-"))
  fs.writeFileSync(path.join(outside, "passwd"), "secret")
  const r = path.join(h.root, "mids", "ab")
  fs.mkdirSync(path.join(r, "agent"), { recursive: true })
  fs.writeFileSync(path.join(r, "agent", "config.xml"), "<x/>")
  fs.symlinkSync(outside, path.join(r, "agent", "evil"))
  fs.symlinkSync(path.join(outside, "passwd"), path.join(r, "agent", "evilfile"))
  fs.symlinkSync(path.join(r, "agent", "config.xml"), path.join(r, "agent", "goodlink"))
  // sibling whose name has "ab" as a prefix
  fs.mkdirSync(path.join(h.root, "mids", "abc"), { recursive: true })
  fs.symlinkSync(path.join(h.root, "mids", "abc"), path.join(r, "agent", "sibling"))
  fs.mkdirSync(path.join(h.root, "mids", "empty-root-missing-x"), { recursive: true })
})
afterAll(() => {
  fs.rmSync(h.root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code: string }).code)

describe("resolveMidPath", () => {
  it("empty rel is the root", async () => {
    expect(await resolveMidPath("ab", "")).toBe(midRoot("ab"))
  })
  it("existing file is inside", async () => {
    expect(await resolveMidPath("ab", "agent/config.xml")).toBe(path.join(midRoot("ab"), "agent/config.xml"))
  })
  it("rejects .. and absolute paths", async () => {
    expect(await code(resolveMidPath("ab", "../other"))).toBe("path_outside")
    expect(await code(resolveMidPath("ab", "agent/../../abc"))).toBe("path_outside")
    expect(await code(resolveMidPath("ab", "/etc/passwd"))).toBe("path_outside")
  })
  it("rejects symlinked directory escaping the root", async () => {
    expect(await code(resolveMidPath("ab", "agent/evil/passwd"))).toBe("path_outside")
    expect(await code(resolveMidPath("ab", "agent/evil/new/file"))).toBe("path_outside")
  })
  it("rejects a final symlink pointing outside, accepts one pointing inside", async () => {
    expect(await code(resolveMidPath("ab", "agent/evilfile"))).toBe("path_outside")
    expect(await code(resolveMidPath("ab", "agent/goodlink"))).toBe("ok")
  })
  it("prefix-sibling MID is not inside", async () => {
    expect(await code(resolveMidPath("ab", "agent/sibling"))).toBe("path_outside")
  })
  it("allows not-yet-existing paths", async () => {
    expect(await resolveMidPath("ab", "agent/new/file.txt")).toBe(path.join(midRoot("ab"), "agent/new/file.txt"))
  })
  it("invalid name -> invalid_name; missing root -> not_found", async () => {
    expect(await code(resolveMidPath("../x", ""))).toBe("invalid_name")
    expect(await code(resolveMidPath("nope", "agent"))).toBe("not_found")
  })
})

describe("isReadOnlyPath", () => {
  const p = (s: string) => path.join(midRoot("ab"), s)
  it.each(["agent/bin", "agent/bin/mid.sh", "agent/jre/x", "agent/lib/a.jar", "agent/jre"])("true for %s", (s) => {
    expect(isReadOnlyPath("ab", p(s))).toBe(true)
  })
  it.each(["agent/extlib/x.jar", "agent/binary.txt", "agent/config.xml", "agent", "agent/libs"])("false for %s", (s) => {
    expect(isReadOnlyPath("ab", p(s))).toBe(false)
  })
  it("false for another MID's agent/bin", () => {
    expect(isReadOnlyPath("ab", path.join(midRoot("abc"), "agent/bin"))).toBe(false)
  })
})
