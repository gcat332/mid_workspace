import { describe, expect, it } from "vitest"
import { toggle, visibleRows, type Entry, type TreeState } from "./file-tree"

const e = (name: string, type: "file" | "dir"): Entry =>
  ({ name, type, size: 0, mtime: "", readOnly: false, symlink: false, locked: false, secret: false, config: false })
const names = (s: TreeState) => visibleRows(s).map((r) => `${r.entry.name}(${r.depth})`)

describe("file tree", () => {
  const root = [e("a", "dir"), e("z.txt", "file"), e("b", "dir")]

  it("lists directories first, then names in order, descending only into expanded dirs", () => {
    const s: TreeState = { children: { "": root, a: [e("x.xml", "file")] }, expanded: new Set(["a"]) }
    expect(names(s)).toEqual(["a(0)", "x.xml(1)", "b(0)", "z.txt(0)"])
    expect(visibleRows(s)[1].path).toBe("a/x.xml")
  })

  it("hides the children of a collapsed dir", () => {
    const s: TreeState = { children: { "": root, a: [e("x.xml", "file")] }, expanded: new Set() }
    expect(names(s)).toEqual(["a(0)", "b(0)", "z.txt(0)"])
  })

  it("shows nothing below an expanded dir that is still loading or failed", () => {
    const s: TreeState = { children: { "": root, a: "loading", b: { error: "x" } }, expanded: new Set(["a", "b"]) }
    expect(names(s)).toEqual(["a(0)", "b(0)", "z.txt(0)"])
  })

  it("toggle collapses an expanded dir and expands a collapsed one, without mutating", () => {
    const s: TreeState = { children: { "": root }, expanded: new Set(["a"]) }
    const t = toggle(s, "a")
    expect(t.expanded.has("a")).toBe(false)
    expect(s.expanded.has("a")).toBe(true)
    expect(toggle(t, "a").expanded.has("a")).toBe(true)
  })
})

describe("parentOf / siblingsOf", () => {
  it("parentOf", async () => {
    const { parentOf } = await import("./file-tree")
    expect(parentOf("a/b/c")).toBe("a/b")
    expect(parentOf("a")).toBe("")
  })
  it("siblingsOf lists display order, [] when not loaded", async () => {
    const { siblingsOf } = await import("./file-tree")
    const s: TreeState = { children: { "": [e("z", "file"), e("b", "dir"), e("a", "file")], l: "loading" }, expanded: new Set() }
    expect(siblingsOf(s, "")).toEqual(["b", "a", "z"])
    expect(siblingsOf(s, "l")).toEqual([])
    expect(siblingsOf(s, "nope")).toEqual([])
  })
})
