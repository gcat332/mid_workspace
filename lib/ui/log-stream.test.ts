import { expect, it } from "vitest"
import { levelMatches, nextBackoff, shouldRetry } from "./log-stream"

it("backoff doubles and caps at 30 s", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 20].map(nextBackoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})
it("does not retry permanent 4xx", () => {
  expect([400, 403, 404].some(shouldRetry)).toBe(false)
  expect([429, 408, 500, 503].every(shouldRetry)).toBe(true)
})
it("level filter matches whole words only", () => {
  expect(levelMatches("12:00 ERROR boom", "ERROR")).toBe(true)
  expect(levelMatches("0 ERRORS found", "ERROR")).toBe(false)
  expect(levelMatches("INFO NOWARN", "WARN")).toBe(false)
  expect(levelMatches("anything", "")).toBe(true)
})
it("WARN+ matches WARN and ERROR lines (Q-M14)", () => {
  expect(levelMatches("12:00 WARN slow", "WARN+")).toBe(true)
  expect(levelMatches("12:00 ERROR boom", "WARN+")).toBe(true)
  expect(levelMatches("12:00 INFO ok", "WARN+")).toBe(false)
  expect(levelMatches("12:00 WARNING x", "WARN+")).toBe(false)
})
