import { describe, it, expect } from "vitest"

import { DEFAULT_MIDHUB_ROOT, MID_NAME_RE, validateMidName, unitName, midRoot, MidError } from "./names"

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
  it("midRoot needs no app secrets and honours MIDHUB_ROOT / explicit root", () => {
    const saved = { ...process.env }
    try {
      for (const k of Object.keys(process.env)) if (/^(JWT_|ADMIN_|MIDHUB_|DATABASE_)/.test(k)) delete process.env[k]
      expect(DEFAULT_MIDHUB_ROOT).toBe("/opt/midhub")
      expect(midRoot("poc")).toBe("/opt/midhub/mids/poc")
      process.env.MIDHUB_ROOT = "/srv/x"
      expect(midRoot("poc")).toBe("/srv/x/mids/poc")
      expect(midRoot("poc", "/r")).toBe("/r/mids/poc")
    } finally {
      process.env = saved
    }
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

import { quotaFullMessage } from "./names"
it("quota_full text is built from the configured maximum (M4)", () => {
  expect(quotaFullMessage(6)).toBe("รันครบ 6 ตัวแล้ว ให้หยุดตัวอื่นก่อน")
  expect(new MidError("quota_full").message).not.toMatch(/\d/)
})

describe("MidError cross-chunk identity", () => {
  it("accepts an object from a separately constructed copy (brand + fields)", async () => {
    const { MidError } = await import("./names")
    const foreign = Object.assign(new Error("x"), { code: "zip_invalid", status: 400, detail: "d" })
    expect(foreign instanceof MidError).toBe(false)
    Object.defineProperty(foreign, Symbol.for("midhub.MidError"), { value: true })
    expect(foreign instanceof MidError).toBe(true)
    expect((null as unknown as object) instanceof MidError).toBe(false)
  })
  it("keeps subclasses strict", async () => {
    const { MidError } = await import("./names")
    const { AgentCheckError } = await import("../agent/checks")
    expect(new MidError("internal") instanceof AgentCheckError).toBe(false)
    expect(new AgentCheckError("m", []) instanceof MidError).toBe(true)
  })
})
