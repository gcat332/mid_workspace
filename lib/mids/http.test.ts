import { describe, it, expect } from "vitest"
import { midErrorResponse } from "./http"
import { MidError } from "./names"

describe("midErrorResponse", () => {
  it("maps MidError to code/message JSON with its status", async () => {
    const res = midErrorResponse(new MidError("read_only"))
    expect(res?.status).toBe(403)
    const body = await res!.json()
    expect(body.code).toBe("read_only")
    expect(body.message).toMatch(/[฀-๿]/)
  })
  it("includes detail only when present", async () => {
    const withDetail = await midErrorResponse(new MidError("systemctl_failed", undefined, undefined, "raw text"))!.json()
    expect(withDetail.detail).toBe("raw text")
    expect("detail" in (await midErrorResponse(new MidError("read_only"))!.json())).toBe(false)
  })
  it("returns null for other errors", () => {
    expect(midErrorResponse(new Error("x"))).toBeNull()
    expect(midErrorResponse("x")).toBeNull()
  })
})
