import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { readLastLines } from "./log-lines"
import type { OpenFn } from "./log-tail"

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-loglines-"))
  file = path.join(dir, "a.log")
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** Opener that records whether its handle was closed. */
function opener() {
  const state = { closed: 0, opens: 0 }
  const open: OpenFn = async () => {
    state.opens++
    const h = await fs.promises.open(file, "r")
    const close = h.close.bind(h)
    h.close = async () => { state.closed++; return close() }
    return { h, st: await h.stat() }
  }
  return { open, state }
}
const lines = (k: number, from = 1) => Array.from({ length: k }, (_, i) => `line ${i + from}`)

it("returns the last n lines, oldest first; trailing newline does not add an empty line", async () => {
  fs.writeFileSync(file, lines(10).join("\n") + "\n")
  const { open, state } = opener()
  expect(await readLastLines(open, 3)).toEqual(["line 8", "line 9", "line 10"])
  expect(state).toEqual({ opens: 1, closed: 1 })
})

it("whole file when it has fewer lines; an unterminated last line is included; CRLF stripped", async () => {
  fs.writeFileSync(file, "a\r\nb\r\nc")
  expect(await readLastLines(opener().open, 50)).toEqual(["a", "b", "c"])
  fs.writeFileSync(file, "")
  expect(await readLastLines(opener().open, 5)).toEqual([])
})

it("reads backwards across many chunks (more than 64 KiB) and keeps UTF-8 intact", async () => {
  const many = Array.from({ length: 20000 }, (_, i) => `บรรทัด ${i + 1} ${"x".repeat(i % 50)}`)
  fs.writeFileSync(file, many.join("\n") + "\n")
  expect(await readLastLines(opener().open, 2000)).toEqual(many.slice(-2000))
})

it("stops at maxBytes and drops the partial first line", async () => {
  fs.writeFileSync(file, lines(1000).join("\n") + "\n")
  const got = await readLastLines(opener().open, 1000, 100)
  expect(got.length).toBeGreaterThan(0)
  expect(got.join("\n").length).toBeLessThanOrEqual(100)
  expect(got[got.length - 1]).toBe("line 1000")
  for (const l of got) expect(l).toMatch(/^line \d+$/) // no cut-off fragment
  expect(lines(1000)).toEqual(expect.arrayContaining(got))
})

it("reads only through the handle (never by path) and closes it on error", async () => {
  fs.writeFileSync(file, "a\nb\n")
  const { open, state } = opener()
  const spy = vi.spyOn(fs.promises, "readFile")
  const realOpen = open
  const failing: OpenFn = async () => {
    const o = await realOpen()
    o.h.read = (async () => { throw new Error("boom") }) as typeof o.h.read
    return o
  }
  await expect(readLastLines(failing, 5)).rejects.toThrow("boom")
  expect(state.closed).toBe(1)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})
