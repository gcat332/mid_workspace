import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { zipStream, type ZipSource } from "./writer"

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zipw-"))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const src = (s: string, chunk = 64 * 1024) => async () => ({
  stream: (async function* () {
    const b = Buffer.from(s)
    for (let i = 0; i < b.length; i += chunk) yield b.subarray(i, i + chunk)
  })(),
  close: async () => {},
})
async function toFile(stream: ReadableStream<Uint8Array>): Promise<string> {
  const file = path.join(tmp, "out.zip")
  await pipeline(Readable.fromWeb(stream as never), fs.createWriteStream(file))
  return file
}

describe("zipStream", () => {
  it("produces an archive unzip -t accepts, with dirs, empty files and UTF-8 names", async () => {
    const zip = await toFile(zipStream([
      { name: "logs/", dir: true, mtime: new Date() },
      { name: "logs/agent0.log.0", mtime: new Date(), open: src("hello\n".repeat(10000)) },
      { name: "logs/ว่าง เปล่า.txt", mtime: new Date(), open: src("") },
    ]))
    expect(execFileSync("unzip", ["-t", zip]).toString()).toMatch(/No errors detected/)
    const list = execFileSync("unzip", ["-Z1", zip]).toString().split("\n")
    expect(list).toEqual(expect.arrayContaining(["logs/", "logs/agent0.log.0", "logs/ว่าง เปล่า.txt"]))
    expect(execFileSync("unzip", ["-p", zip, "logs/agent0.log.0"]).toString()).toBe("hello\n".repeat(10000))
  })

  it("accepts an async iterable of sources and closes each source", async () => {
    let closed = 0
    async function* gen(): AsyncGenerator<ZipSource> {
      yield { name: "a.txt", mtime: new Date(), open: async () => ({ ...(await src("abc")()), close: async () => { closed++ } }) }
    }
    const zip = await toFile(zipStream(gen()))
    expect(execFileSync("unzip", ["-p", zip, "a.txt"]).toString()).toBe("abc")
    expect(closed).toBe(1)
  })

  it("a source that returns null is left out, the archive stays valid", async () => {
    const zip = await toFile(zipStream([
      { name: "gone.txt", mtime: new Date(), open: async () => null },
      { name: "kept.txt", mtime: new Date(), open: src("kept") },
    ]))
    expect(execFileSync("unzip", ["-t", zip]).toString()).toMatch(/No errors detected/)
    expect(execFileSync("unzip", ["-Z1", zip]).toString().trim().split("\n")).toEqual(["kept.txt"])
  })

  it("an error in a source errors the stream (no silently truncated archive)", async () => {
    let closed = false
    const bad: ZipSource = {
      name: "bad.txt",
      mtime: new Date(),
      open: async () => ({
        stream: (async function* () {
          yield Buffer.from("partial")
          throw new Error("boom")
        })(),
        close: async () => { closed = true },
      }),
    }
    await expect(toFile(zipStream([bad]))).rejects.toThrow(/boom/)
    expect(closed).toBe(true)
  })

  it("memory stays flat for a 100 MB source streamed in 64 KiB chunks", async () => {
    const chunk = Buffer.alloc(64 * 1024, "x")
    const total = 100 * 1024 * 1024
    const open = async () => ({
      stream: (async function* () {
        for (let n = 0; n < total; n += chunk.length) yield chunk
      })(),
      close: async () => {},
    })
    global.gc?.()
    const before = process.memoryUsage().heapUsed
    let peak = 0
    const file = path.join(tmp, "big.zip")
    const out = fs.createWriteStream(file)
    const rs = zipStream([{ name: "big.bin", mtime: new Date(), open }]).getReader()
    for (;;) {
      const { done, value } = await rs.read()
      if (done) break
      if (!out.write(value)) await new Promise((r) => out.once("drain", r))
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }
    await new Promise<void>((r) => out.end(() => r()))
    expect(peak - before).toBeLessThan(64 * 1024 * 1024)
    expect(execFileSync("unzip", ["-t", file], { maxBuffer: 1 << 20 }).toString()).toMatch(/No errors detected/)
  }, 60_000)
})
