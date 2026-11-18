import { it, expect } from "vitest"
import { responseOrRethrow } from "@/lib/auth/helpers"

it("returns a thrown Response", () => {
  const r = new Response("x", { status: 401 })
  expect(responseOrRethrow(r)).toBe(r)
})

it("rethrows anything that is not a Response", () => {
  const e = new Error("db down")
  expect(() => responseOrRethrow(e)).toThrow(e)
})
