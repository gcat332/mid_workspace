import { describe, expect, it } from "vitest"
import { instanceRecordUrl } from "./record-link"

describe("instanceRecordUrl", () => {
  it("joins with exactly one slash and encodes the name", () => {
    expect(instanceRecordUrl("https://d.service-now.com/", "a b&c")).toBe("https://d.service-now.com/ecc_agent_list.do?sysparm_query=name=a%20b%26c")
    expect(instanceRecordUrl("https://d.service-now.com", "m1")).toBe("https://d.service-now.com/ecc_agent_list.do?sysparm_query=name=m1")
  })
  it("is null for a missing/unsafe url or name", () => {
    expect(instanceRecordUrl(null, "m")).toBeNull()
    expect(instanceRecordUrl("javascript:alert(1)", "m")).toBeNull()
    expect(instanceRecordUrl("https://d.service-now.com", null)).toBeNull()
  })
})
