import { it, expect } from "vitest"
import { validLoginNext } from "./login-next"

it("accepts only /midhub paths", () => {
  expect(validLoginNext("/midhub")).toBe("/midhub")
  expect(validLoginNext("/midhub/mids?x=1")).toBe("/midhub/mids?x=1")
})
it("rejects open-redirect shapes", () => {
  for (const v of ["//evil", "https://evil.com", "/midhubx", "/midhub\\evil", "/\\evil", "/midhub//..\\x", "/other", "", null, undefined])
    expect(validLoginNext(v as string)).toBeNull()
})
