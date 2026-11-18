import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/env", () => ({ env: { midhubRoot: "/opt/midhub" } }))

import { MID_NAME_RE, validateMidName, unitName, midRoot, MidError } from "./names"

describe("MID names", () => {
  it.each(["a", "-ab", "Ab", "a_b", "a".repeat(41), "", "ab/c", "..", "ab "])("rejects %j", (n) => {
    expect(() => validateMidName(n)).toThrowError(MidError)
    try {
      validateMidName(n)
    } catch (e) {
      expect((e as MidError).code).toBe("invalid_name")
      expect((e as MidError).status).toBe(400)
    }
  })
  it.each(["ab", "poc-hr-mid", "a".repeat(40), "1a"])("accepts %j", (n) => {
    expect(validateMidName(n)).toBe(n)
    expect(MID_NAME_RE.test(n)).toBe(true)
  })
  it("builds unit name and root", () => {
    expect(unitName("poc")).toBe("midhub-mid-poc.service")
    expect(midRoot("poc")).toBe("/opt/midhub/mids/poc")
  })
  it("unitName/midRoot validate the name", () => {
    expect(() => unitName("../x")).toThrowError(MidError)
    expect(() => midRoot("../x")).toThrowError(MidError)
  })
})

describe("MidError", () => {
  it("defaults status and Thai message from the table", () => {
    const e = new MidError("too_large")
    expect(e.status).toBe(413)
    expect(e.message).toMatch(/[฀-๿]/)
    expect(new MidError("low_memory").status).toBe(409)
    expect(new MidError("conflict").status).toBe(409)
    expect(new MidError("helper_down").status).toBe(503)
  })
  it("allows overrides", () => {
    const e = new MidError("not_found", 410, "x")
    expect([e.status, e.message]).toEqual([410, "x"])
  })
})
