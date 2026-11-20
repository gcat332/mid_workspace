import { describe, expect, it } from "vitest"
import { clickSelect, EMPTY_SELECTION, pruneSelection, selectAll } from "./selection"

const sib = ["d/a", "d/b", "d/c", "d/e"]
const none = { toggle: false, range: false }

describe("selection", () => {
  it("plain click selects only that path", () => {
    expect(clickSelect(EMPTY_SELECTION, "d/b", none, sib)).toEqual({ parent: "d", paths: ["d/b"], anchor: "d/b" })
  })
  it("toggle adds and removes within the same parent", () => {
    const s1 = clickSelect(EMPTY_SELECTION, "d/a", none, sib)
    const s2 = clickSelect(s1, "d/c", { toggle: true, range: false }, sib)
    expect(s2.paths).toEqual(["d/a", "d/c"])
    expect(clickSelect(s2, "d/a", { toggle: true, range: false }, sib).paths).toEqual(["d/c"])
  })
  it("toggle in another parent starts over", () => {
    const s1 = clickSelect(EMPTY_SELECTION, "d/a", none, sib)
    expect(clickSelect(s1, "x/y", { toggle: true, range: false }, ["x/y"])).toEqual({ parent: "x", paths: ["x/y"], anchor: "x/y" })
  })
  it("range selects the slice in both directions and keeps the anchor", () => {
    const s1 = clickSelect(EMPTY_SELECTION, "d/b", none, sib)
    expect(clickSelect(s1, "d/e", { toggle: false, range: true }, sib)).toEqual({ parent: "d", paths: ["d/b", "d/c", "d/e"], anchor: "d/b" })
    expect(clickSelect(s1, "d/a", { toggle: false, range: true }, sib).paths).toEqual(["d/a", "d/b"])
  })
  it("range without a usable anchor acts as a plain click", () => {
    expect(clickSelect(EMPTY_SELECTION, "d/c", { toggle: false, range: true }, sib).paths).toEqual(["d/c"])
  })
  it("selectAll and pruneSelection", () => {
    const all = selectAll("d", sib)
    expect(all.paths).toEqual(sib)
    const p = pruneSelection(all, ["d/a", "d/c"])
    expect(p.paths).toEqual(["d/a", "d/c"])
    expect(p.anchor).toBe("d/a")
    expect(pruneSelection(all, sib)).toBe(all)
  })
})
