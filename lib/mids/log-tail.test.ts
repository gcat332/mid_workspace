import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openFile } from "./safe-fs"
import { MidError } from "./names"
import { tailFile } from "./log-tail"

let dir: string
let log: string
let ac: AbortController
const fds = () => fs.readdirSync("/proc/self/fd").length
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "midhub-tail-")))
  log = path.join(dir, "root", "a.log")
  fs.mkdirSync(path.dirname(log))
  ac = new AbortController()
})
afterEach(() => { ac.abort(); fs.rmSync(dir, { recursive: true, force: true }) })

const root = () => path.join(dir, "root")
const openLog = () => openFile(log, "r", (real) => {
  if (!real.startsWith(root() + path.sep)) throw new MidError("path_outside")
})
const start = (o: { fromBytesBack?: number; maxLineBytes?: number; onStatus?: (s: "missing" | "live") => void } = {}) =>
  tailFile(openLog, { fromBytesBack: 1024, pollMs: 10, signal: ac.signal, ...o })

/** Collects lines until `n` are seen (or 3 s). */
async function collect(it: AsyncGenerator<string[]>, n: number): Promise<string[]> {
  const got: string[] = []
  const timer = setTimeout(() => ac.abort(), 3000)
  try {
    for await (const b of it) { got.push(...b); if (got.length >= n) break }
  } finally { clearTimeout(timer) }
  return got
}

describe("tailFile", () => {
  it("yields appended lines", async () => {
    fs.writeFileSync(log, "")
    const p = collect(start(), 3)
    await sleep(30)
    fs.appendFileSync(log, "a\nb\nc\n")
    expect(await p).toEqual(["a", "b", "c"])
  })

  it("starts within the byte window and drops the partial first line", async () => {
    fs.writeFileSync(log, "line1\nline2\nline3\n")
    expect(await collect(start({ fromBytesBack: 8 }), 1)).toEqual(["line3"])
    ac = new AbortController()
    expect(await collect(start({ fromBytesBack: 1000 }), 3)).toEqual(["line1", "line2", "line3"])
  })

  it("holds a partial trailing line until it is completed", async () => {
    fs.writeFileSync(log, "")
    const batches: string[][] = []
    const p = (async () => { for await (const b of start()) { batches.push(b); if (batches.flat().length >= 2) break } })()
    await sleep(30)
    fs.appendFileSync(log, "one\npart")
    await sleep(80)
    expect(batches.flat()).toEqual(["one"])
    fs.appendFileSync(log, "ial\n")
    await p
    expect(batches.flat()).toEqual(["one", "partial"])
  })

  it("restarts from 0 after truncation without repeating old lines", async () => {
    fs.writeFileSync(log, "old1\nold2\n")
    const p = collect(start(), 3)
    await sleep(60)
    fs.truncateSync(log, 0)
    await sleep(30)
    fs.appendFileSync(log, "new\n")
    expect(await p).toEqual(["old1", "old2", "new"])
  })

  it("follows a rotated file (rename + new file), finishing the old one first", async () => {
    fs.writeFileSync(log, "a\n")
    const p = collect(start(), 4)
    await sleep(60)
    fs.appendFileSync(log, "b\n")
    fs.renameSync(log, log + ".1")
    fs.writeFileSync(log, "c\nd\n")
    expect(await p).toEqual(["a", "b", "c", "d"])
  })

  it("waits quietly for a missing file and reports status", async () => {
    const st: string[] = []
    const p = collect(start({ onStatus: (s) => st.push(s) }), 1)
    await sleep(60)
    fs.writeFileSync(log, "hi\n")
    expect(await p).toEqual(["hi"])
    expect(st).toEqual(["missing", "live"])
  })

  it("abort ends the iterator", async () => {
    fs.writeFileSync(log, "x\n")
    const it = start()
    await it.next()
    const done = it.next()
    ac.abort()
    expect((await done).done).toBe(true)
  })

  it("closes every handle after abort", async () => {
    fs.writeFileSync(log, "x\n")
    const before = fds()
    const it = start()
    await it.next()
    await sleep(80) // several re-open polls
    ac.abort()
    while (!(await it.next()).done) { /* drain */ }
    expect(fds()).toBe(before)
  })

  it("never follows a symlink swapped in after start", async () => {
    const secret = path.join(dir, "secret.txt")
    fs.writeFileSync(secret, "TOP SECRET\n")
    fs.writeFileSync(log, "a\n")
    const p = collect(start(), 2)
    await sleep(60)
    fs.unlinkSync(log)
    fs.symlinkSync(secret, log)
    await sleep(120)
    fs.appendFileSync(secret, "MORE SECRET\n")
    await sleep(60)
    ac.abort()
    const got = await p
    expect(got).toEqual(["a"])
  })

  it("does not hang on a FIFO at the log path", async () => {
    execFileSync("mkfifo", [log])
    const t0 = Date.now()
    await expect(start().next()).rejects.toMatchObject({ code: "invalid_request" })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it("truncates a very long line", async () => {
    fs.writeFileSync(log, "x".repeat(100_000) + "\nok\n")
    const got = await collect(start({ fromBytesBack: 1_000_000, maxLineBytes: 100 }), 2)
    expect(got[0]).toBe("x".repeat(100) + "…")
    expect(got[1]).toBe("ok")
  })
})

describe("tailFile hardening", () => {
  it("emits several bounded batches after a burst", async () => {
    fs.writeFileSync(log, Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n") + "\n")
    const sizes: number[] = []
    const all: string[] = []
    for await (const b of start({ fromBytesBack: 10_000_000 })) { sizes.push(b.length); all.push(...b); if (all.length >= 2500) break }
    expect(all).toHaveLength(2500)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000)
    expect(sizes.length).toBeGreaterThanOrEqual(3)
  })

  it("detects truncate + regrowth past the old offset within one poll", async () => {
    fs.writeFileSync(log, "aaaa\nbbbb\n")
    const p = collect(start(), 5)
    await sleep(60)
    fs.truncateSync(log, 0)
    fs.appendFileSync(log, "cccccc\ndddddd\neeeeeeee\n")
    expect(await p).toEqual(["aaaa", "bbbb", "cccccc", "dddddd", "eeeeeeee"])
  })

  it("drops the fragment when the window ends inside a line with no newline", async () => {
    fs.writeFileSync(log, "x".repeat(20000)) // no newline at all
    ac = new AbortController()
    const p = collect(start({ fromBytesBack: 5000 }), 1)
    await sleep(60)
    fs.appendFileSync(log, "tail-of-line\nnext\n")
    expect(await p).toEqual(["next"])
  })

  it("closes the fresh handle when finishing the old file fails during rotation", async () => {
    fs.writeFileSync(log, "a\n")
    const before = fds()
    let firstIno = 0
    let failStat = false
    const open = async () => {
      const o = await openLog()
      if (!firstIno) {
        firstIno = o.st.ino
        const real = o.h.stat.bind(o.h)
        o.h.stat = ((...a: Parameters<typeof real>) => (failStat ? Promise.reject(new Error("boom")) : real(...a))) as typeof o.h.stat
      } else if (o.st.ino !== firstIno) failStat = true
      return o
    }
    const it = tailFile(open, { fromBytesBack: 1024, pollMs: 10, signal: ac.signal })
    await it.next()
    fs.renameSync(log, log + ".1")
    fs.writeFileSync(log, "b\n")
    await expect((async () => { for (;;) if ((await it.next()).done) return })()).rejects.toThrow("boom")
    expect(fds()).toBe(before)
  })
})
