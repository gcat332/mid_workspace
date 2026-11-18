import { expect, it } from "vitest"
import { tabKeyTarget } from "./tabs"

it("WAI-ARIA tabs: ArrowLeft/Right wrap, Home/End jump, other keys ignored (Q-M13)", () => {
  expect(tabKeyTarget("ArrowRight", 0, 4)).toBe(1)
  expect(tabKeyTarget("ArrowRight", 3, 4)).toBe(0)
  expect(tabKeyTarget("ArrowLeft", 0, 4)).toBe(3)
  expect(tabKeyTarget("Home", 2, 4)).toBe(0)
  expect(tabKeyTarget("End", 1, 4)).toBe(3)
  expect(tabKeyTarget("Enter", 1, 4)).toBeNull()
})
