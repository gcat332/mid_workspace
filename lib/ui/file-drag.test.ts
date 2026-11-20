import { describe, expect, it } from "vitest"
import { canMoveTo, createBlockReason, downloadUrlData, zipFilename, zipUrl } from "./file-drag"
import type { Entry } from "./file-tree"

const ent = (o: Partial<Entry> = {}): Entry =>
  ({ name: "x", type: "dir", size: 0, mtime: "", readOnly: false, symlink: false, locked: false, secret: false, config: false, ...o })
const mk = (entries: Record<string, Partial<Entry>> = {}, extra: Partial<{ roDirs: Record<string, boolean>; busy: boolean }> = {}) => ({
  roDirs: {}, busy: false, ...extra, entry: (p: string) => (p in entries ? ent(entries[p]) : undefined),
})

describe("canMoveTo", () => {
  it("allows a plain folder", () => {
    expect(canMoveTo(["agent/a.jar"], "agent/extlib", mk())).toBe(true)
    expect(canMoveTo(["agent/extlib/a.jar"], "work", mk())).toBe(true)
  })
  it("refuses the current parent, itself and descendants", () => {
    expect(canMoveTo(["work/a", "other/b"], "work", mk())).toBe(false)
    expect(canMoveTo(["work/a"], "work/a", mk())).toBe(false)
    expect(canMoveTo(["work/a"], "work/a/sub", mk())).toBe(false)
    expect(canMoveTo(["work/ab"], "work/a", mk())).toBe(true)
  })
  it("refuses read-only, symlink, busy and protected targets", () => {
    expect(canMoveTo(["a"], "ro", mk({}, { roDirs: { ro: true } }))).toBe(false)
    expect(canMoveTo(["a"], "ln", mk({ ln: { symlink: true } }))).toBe(false)
    expect(canMoveTo(["a"], "work", mk({}, { busy: true }))).toBe(false)
    expect(canMoveTo(["a"], "agent/conf", mk())).toBe(false)
    expect(canMoveTo(["a"], "agent/conf/sub", mk())).toBe(false)
    expect(canMoveTo(["a"], "agent/confx", mk())).toBe(true)
  })
  it("refuses a target whose own listing says read-only (an unloaded subfolder of agent/lib)", () => {
    expect(canMoveTo(["a"], "agent/lib/x", mk({ "agent/lib/x": { readOnly: true } }))).toBe(false)
    expect(canMoveTo(["a"], "work/x", mk({ "work/x": { readOnly: false } }))).toBe(true)
  })
  it("refuses locked, symlink and secret sources", () => {
    for (const k of ["locked", "symlink", "secret"] as const)
      expect(canMoveTo(["s/f"], "work", mk({ "s/f": { type: "file", [k]: true } }))).toBe(false)
  })
})

describe("zip helpers", () => {
  it("zipUrl repeats name= and encodes Thai", () => {
    const u = zipUrl("/mids/m%201/files", "agent/โฟลเดอร์", ["ไฟล์ 1", "b&c"], true)
    expect(u.startsWith("/mids/m%201/files/zip?")).toBe(true)
    const q = new URL(u, "http://x").searchParams
    expect(q.get("dir")).toBe("agent/โฟลเดอร์")
    expect(q.getAll("name")).toEqual(["ไฟล์ 1", "b&c"])
    expect(q.get("check")).toBe("1")
    expect(zipUrl("/b", "", [])).toBe("/b/zip?dir=")
  })
  it("zipFilename follows planZip", () => {
    expect(zipFilename("mid1", "a/b", ["x"])).toBe("x.zip")
    expect(zipFilename("mid1", "a/b", ["x", "x"])).toBe("x.zip")
    expect(zipFilename("mid1", "a/b", ["x", "y"])).toBe("b.zip")
    expect(zipFilename("mid1", "a/b", [])).toBe("b.zip")
    expect(zipFilename("mid1", "", [])).toBe("mid1.zip")
    expect(zipFilename("mid1", "./", ["x", "y"])).toBe("mid1.zip")
    expect(zipFilename("mid1", "a/./", [])).toBe("a.zip")
  })
  it("downloadUrlData", () => {
    expect(downloadUrlData("a.zip", "http://h/z")).toBe("application/octet-stream:a.zip:http://h/z")
  })
  it("downloadUrlData replaces ':' in the filename so Chrome's colon-delimited format still parses", () => {
    expect(downloadUrlData("a:b.txt", "http://h/z")).toBe("application/octet-stream:a_b.txt:http://h/z")
  })
})

describe("createBlockReason", () => {
  it("names a level-1 protected folder and what is still possible; free folders have none", () => {
    expect(createBlockReason("agent/conf")).toContain("agent/conf")
    expect(createBlockReason("agent/security/deep")).toContain("agent/security/deep")
    for (const d of ["", "work", "agent", "agent/logs", "agent/confx"]) expect(createBlockReason(d)).toBeNull()
  })
})
