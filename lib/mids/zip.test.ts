import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ mids: [] as { name: string; state: string }[] }))
vi.mock("@/lib/db/client", () => ({
  prisma: { job: { findFirst: async () => null, findMany: async () => [] }, midServer: { findUnique: async ({ where }: { where: { name: string } }) => db.mids.find((m) => m.name === where.name) ?? null } },
}))
vi.mock("@/lib/mids/status", () => ({ readServiceStatus: async () => ({ state: "inactive", pid: null, memoryBytes: null, since: null }), runSystemctl: async () => ({ code: 0, stdout: "" }) }))

import { ZIP_MAX_BYTES, ZIP_MAX_FILES, planZip, zipPlanStream } from "./zip"

let root: string
let m: string
const rejects = (p: Promise<unknown>, code: string, status?: number) =>
  expect(p).rejects.toMatchObject({ code, ...(status ? { status } : {}) })

async function toFile(s: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  const r = s.getReader()
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  const f = path.join(root, "out.zip")
  fs.writeFileSync(f, Buffer.concat(chunks))
  return f
}
const openFds = () => fs.readdirSync("/proc/self/fd").length

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-zip-"))
  process.env.MIDHUB_ROOT = root
  m = path.join(root, "mids", "m1")
  for (const d of ["agent/bin", "agent/conf", "agent/extlib", "agent/empty", "work"]) fs.mkdirSync(path.join(m, d), { recursive: true })
  fs.writeFileSync(path.join(m, "agent/config.xml"), "<parameters/>")
  fs.writeFileSync(path.join(m, "agent/conf/wrapper-override.conf"), "a=1\n")
  fs.writeFileSync(path.join(m, "agent/bin/mid.sh"), "#!/bin/sh\n")
  fs.writeFileSync(path.join(m, "work/note.txt"), "hello")
  db.mids.length = 0
  db.mids.push({ name: "m1", state: "installed" })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

describe("planZip", () => {
  it("whole folder: relative names, skips config.xml, symlinks, temp files", async () => {
    fs.symlinkSync("/etc", path.join(m, "agent/out")); fs.writeFileSync(path.join(m, "agent/.midhub-upload-0123456789abcdef.part"), "")
    const p = await planZip("m1", "agent", [])
    const names = p.entries.map((e) => e.zipName)
    expect(names).toContain("agent/conf/wrapper-override.conf")
    expect(names).toContain("agent/empty/")
    expect(names.some((n) => n.endsWith("config.xml") || n.includes("out") || n.includes(".part"))).toBe(false)
    expect(p.filename).toBe("agent.zip")
    expect(p.files).toBe(p.entries.filter((e) => !e.dir).length)
  })
  it("MID root is nested under the MID name", async () => {
    const p = await planZip("m1", "", [])
    expect(p.entries.map((e) => e.zipName)).toContain("m1/work/note.txt")
  })
  it("selection: entries at the zip root; filename rules", async () => {
    const one = await planZip("m1", "work", ["note.txt"])
    expect(one.filename).toBe("note.txt.zip")
    expect(one.entries.map((e) => e.zipName)).toEqual(["note.txt"])
    const two = await planZip("m1", "agent", ["conf", "extlib"])
    expect(two.filename).toBe("agent.zip")
    expect(two.entries.map((e) => e.zipName)).toEqual(["conf/", "conf/wrapper-override.conf", "extlib/"])
    expect((await planZip("m1", "", [])).filename).toBe("m1.zip")
    await rejects(planZip("m1", "work", ["nope"]), "not_found", 404)
    await rejects(planZip("m1", "work", ["../x"]), "invalid_filename", 400)
  })
  it("several names: config.xml, symlinks and upload temp files are skipped, not an error", async () => {
    fs.symlinkSync("/etc", path.join(m, "agent/out")); fs.writeFileSync(path.join(m, "agent/.midhub-upload-0123456789abcdef.part"), "")
    const p = await planZip("m1", "agent", ["config.xml", "out", ".midhub-upload-0123456789abcdef.part", "conf", "extlib"])
    expect(p.entries.map((e) => e.zipName)).toEqual(["conf/", "conf/wrapper-override.conf", "extlib/"])
    await rejects(planZip("m1", "agent", ["config.xml", "conf", "nope"]), "not_found", 404) // a missing name is still an error
  })
  it("several names with nothing includable fails; a single excluded name keeps its error", async () => {
    fs.symlinkSync("/etc", path.join(m, "agent/out"))
    await rejects(planZip("m1", "agent", ["config.xml", "out"]), "use_config_tab", 403)
    fs.symlinkSync("/etc", path.join(m, "agent/out2"))
    await rejects(planZip("m1", "agent", ["out", "out2"]), "not_found", 404)
    await rejects(planZip("m1", "agent", ["config.xml"]), "use_config_tab", 403)
    await rejects(planZip("m1", "agent", ["out"]), "not_found", 404)
  })
  it("over 10 000 files is too_large before any byte", async () => {
    for (let i = 0; i <= ZIP_MAX_FILES; i++) fs.writeFileSync(path.join(m, "work", `f${i}`), "")
    const t = Date.now()
    await rejects(planZip("m1", "work", []), "too_large", 413)
    expect(Date.now() - t).toBeLessThan(10_000)
  }, 30_000)
  it("over 1 GiB is too_large", async () => {
    fs.writeFileSync(path.join(m, "work/big"), "")
    fs.truncateSync(path.join(m, "work/big"), ZIP_MAX_BYTES + 1)
    await rejects(planZip("m1", "work", []), "too_large", 413)
    fs.truncateSync(path.join(m, "work/big"), ZIP_MAX_BYTES - 5)
    expect((await planZip("m1", "work", [])).bytes).toBe(ZIP_MAX_BYTES)
  })
  it("closes every fd it opened", async () => {
    fs.mkdirSync(path.join(m, "work/a/b/c"), { recursive: true })
    const before = openFds()
    await planZip("m1", "", [])
    await rejects(planZip("m1", "work", ["nope"]), "not_found")
    expect(openFds()).toBe(before)
  })
})

describe("zipPlanStream", () => {
  it("produces a valid archive including empty dirs", async () => {
    const zip = await toFile(zipPlanStream("m1", await planZip("m1", "agent", [])))
    expect(execFileSync("unzip", ["-p", zip, "agent/conf/wrapper-override.conf"]).toString()).toBe("a=1\n")
    expect(execFileSync("unzip", ["-l", zip]).toString()).toContain("agent/empty/")
  })
  it("a file growing after the plan is cut at the planned size; the archive is valid", async () => {
    const plan = await planZip("m1", "work", ["note.txt"])
    fs.appendFileSync(path.join(m, "work/note.txt"), "MORE")
    const zip = await toFile(zipPlanStream("m1", plan))
    expect(execFileSync("unzip", ["-p", zip, "note.txt"]).toString()).toBe("hello")
  })
  it("a file swapped for a symlink to outside after the plan is skipped (never followed)", async () => {
    fs.writeFileSync(path.join(root, "secret"), "TOPSECRET")
    fs.writeFileSync(path.join(m, "work/other.txt"), "ok")
    const plan = await planZip("m1", "work", ["note.txt", "other.txt"])
    fs.rmSync(path.join(m, "work/note.txt"))
    fs.symlinkSync(path.join(root, "secret"), path.join(m, "work/note.txt"))
    const zip = await toFile(zipPlanStream("m1", plan))
    const listing = execFileSync("unzip", ["-l", zip]).toString()
    expect(listing).not.toContain("note.txt")
    expect(execFileSync("unzip", ["-p", zip, "other.txt"]).toString()).toBe("ok")
  })
  it("a symlink to another file inside the MID is not followed either", async () => {
    const plan = await planZip("m1", "work", ["note.txt"])
    fs.rmSync(path.join(m, "work/note.txt"))
    fs.symlinkSync(path.join(m, "agent/conf/wrapper-override.conf"), path.join(m, "work/note.txt"))
    const zip = await toFile(zipPlanStream("m1", plan))
    expect(fs.statSync(zip).size).toBe(22) // only the end-of-central-directory record: nothing was read
  })
  it("a file deleted after the plan is skipped; cancel closes the open file", async () => {
    fs.writeFileSync(path.join(m, "work/big.bin"), Buffer.alloc(5 * 1024 * 1024, 7))
    const plan = await planZip("m1", "work", ["big.bin", "note.txt"])
    const before = openFds()
    const s = zipPlanStream("m1", plan)
    const r = s.getReader()
    await r.read()
    await r.read()
    await r.cancel()
    expect(openFds()).toBe(before)
    fs.rmSync(path.join(m, "work/note.txt"))
    const zip = await toFile(zipPlanStream("m1", plan))
    expect(execFileSync("unzip", ["-l", zip]).toString()).not.toContain("note.txt")
  })
})
