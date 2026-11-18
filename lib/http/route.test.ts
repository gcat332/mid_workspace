import { afterEach, expect, it, vi } from "vitest"
import { handleRouteError } from "./route"
import { MidError } from "@/lib/mids/names"

afterEach(() => vi.restoreAllMocks())

it("returns a thrown Response as-is", () => {
  const r = new Response("x", { status: 401 })
  expect(handleRouteError(r)).toBe(r)
})

it("maps MidError to its status and code", async () => {
  const res = handleRouteError(new MidError("not_found"))
  expect(res.status).toBe(404)
  expect((await res.json()).code).toBe("not_found")
})

it("logs anything else and returns a Thai 500 with the message as detail", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const res = handleRouteError(new Error("boom"))
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({
    code: "internal",
    message: "เกิดข้อผิดพลาดภายในระบบ ลองใหม่อีกครั้ง หากยังไม่ได้ให้แจ้ง Admin",
    detail: "boom",
  })
  expect(log).toHaveBeenCalled()
})
