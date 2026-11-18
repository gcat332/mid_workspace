import { describe, expect, it } from "vitest"
import { createLatest } from "./latest"

describe("createLatest", () => {
  it("only the newest token is current (older poll resolving late is ignored)", () => {
    const l = createLatest()
    const poll = l.next()
    const afterAction = l.next()
    expect(l.isCurrent(poll)).toBe(false)
    expect(l.isCurrent(afterAction)).toBe(true)
  })
})
