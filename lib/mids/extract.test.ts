import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_UNCOMPRESSED, checkListing, extractPackage, hooks, validateZip } from "./extract"
import { VALID_ENTRIES, makeZip, type ZipEntry } from "./test-fixtures/make-zip"

let root: string
let mids: string
let zips: string
const rejects = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code })
const zip = async (name: string, entries: ZipEntry[]) => {
  const p = path.join(zips, name)
  await makeZip(p, entries)
  return p
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-extract-"))
  process.env.MIDHUB_ROOT = root
  mids = path.join(root, "mids")
  zips = path.join(root, "zips")
  fs.mkdirSync(mids)
  fs.mkdirSync(zips)
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

describe("validateZip", () => {
  it("accepts a valid layout", async () => {
    await validateZip(await zip("ok.zip", VALID_ENTRIES))
  })
  it.each([
    ["dotdot", [{ name: "../evil", data: "x" }]],
    ["nested dotdot", [{ name: "agent/../../evil", data: "x" }]],
    ["absolute", [{ name: "/etc/evil", data: "x" }]],
    ["backslash", [{ name: "agent\\evil", data: "x" }]],
    ["outside prefix", [{ name: "other/file", data: "x" }]],
    ["symlink", [{ name: "agent/link", symlinkTo: "/etc" }]],
  ] as [string, ZipEntry[]][])("rejects %s", async (n, extra) => {
    await rejects(validateZip(await zip(`${n}.zip`, [...VALID_ENTRIES, ...extra])), "zip_invalid")
  })
  it("rejects a zip missing agent/config.xml or mid.sh", async () => {
    await rejects(validateZip(await zip("a.zip", VALID_ENTRIES.filter((e) => e.name !== "agent/config.xml"))), "zip_invalid")
    await rejects(validateZip(await zip("b.zip", VALID_ENTRIES.filter((e) => e.name !== "agent/bin/mid.sh"))), "zip_invalid")
  })
  it("rejects a non-zip file", async () => {
    const p = path.join(zips, "x.zip")
    fs.writeFileSync(p, "not a zip")
    await rejects(validateZip(p), "zip_invalid")
  })
})

describe("checkListing size guards", () => {
  const line = (size: number, name: string) => `-rw-------  2.0 unx ${String(size).padStart(8)} b- defN 26-Jan-01 00:00 ${name}`
  const base = ["agent/bin/mid.sh", "agent/config.xml"]
  it("rejects declared uncompressed total above 2 GB", () => {
    const long = [line(MAX_UNCOMPRESSED, base[0]), line(1, base[1])].join("\n")
    expect(() => checkListing(base.join("\n"), long)).toThrow(expect.objectContaining({ code: "zip_invalid" }))
  })
  it("accepts within limits and rejects too many entries", () => {
    expect(() => checkListing(base.join("\n"), base.map((n) => line(10, n)).join("\n"))).not.toThrow()
    const many = Array.from({ length: 20001 }, (_, i) => `agent/f${i}`)
    expect(() => checkListing(many.join("\n"), "")).toThrow(expect.objectContaining({ code: "zip_invalid" }))
  })
  it("rejects when the listings disagree", () => {
    expect(() => checkListing(base.join("\n"), line(1, base[0]))).toThrow(expect.objectContaining({ code: "zip_invalid" }))
  })
})

describe("extractPackage", () => {
  it("extracts a valid zip and leaves no .extract-*", async () => {
    await extractPackage(await zip("ok.zip", VALID_ENTRIES), "m1", "job1")
    expect(fs.existsSync(path.join(mids, "m1/agent/bin/mid.sh"))).toBe(true)
    expect(fs.readFileSync(path.join(mids, "m1/.midhub-installed-by"), "utf8")).toBe("job1")
    expect(fs.readdirSync(mids).filter((n) => n.startsWith(".extract-"))).toEqual([])
    expect(fs.readdirSync(path.join(root, "staging"))).toEqual([])
    expect(fs.statSync(path.join(root, "staging")).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(mids, "m1/agent")).mode & 0o7777).toBe(0o2775)
    expect(fs.statSync(path.join(mids, "m1/agent/bin/mid.sh")).mode & 0o777).toBe(0o775)
    expect(fs.statSync(path.join(mids, "m1/agent/config.xml")).mode & 0o777).toBe(0o664)
  })
  it("a symlink entry in the zip is rejected by the tree walk even without validateZip", async () => {
    const p = await zip("l.zip", [...VALID_ENTRIES, { name: "agent/link", symlinkTo: "/etc" }])
    await rejects(extractPackage(p, "m1", "job1"), "zip_invalid")
    expect(fs.readdirSync(mids)).toEqual([])
  })
  it("is a no-op for the same job id; replaces a leftover tmp; conflicts for another job", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    await extractPackage(p, "m1", "job1")
    fs.writeFileSync(path.join(mids, "m1/marker-keep"), "k")
    await extractPackage(p, "m1", "job1")
    expect(fs.existsSync(path.join(mids, "m1/marker-keep"))).toBe(true)
    await rejects(extractPackage(p, "m1", "job2"), "conflict")
    fs.mkdirSync(path.join(root, "staging/.extract-job3/stale"), { recursive: true, mode: 0o700 })
    await extractPackage(p, "m2", "job3")
    expect(fs.existsSync(path.join(mids, "m2/agent/config.xml"))).toBe(true)
    expect(fs.existsSync(path.join(mids, "m2/stale"))).toBe(false)
  })
  it("removes the temp dir when aborted before start", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    const ac = new AbortController()
    ac.abort()
    await expect(extractPackage(p, "m1", "job1", ac.signal)).rejects.toThrow()
    expect(fs.readdirSync(mids)).toEqual([])
    expect(fs.readdirSync(path.join(root, "staging"))).toEqual([])
  })
  it("aborts while unzip is running and cleans up", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    const ac = new AbortController()
    hooks.onSpawn = () => ac.abort()
    try {
      await expect(extractPackage(p, "m1", "job1", ac.signal)).rejects.toThrow()
    } finally {
      hooks.onSpawn = undefined
    }
    expect(fs.readdirSync(mids)).toEqual([])
    expect(fs.readdirSync(path.join(root, "staging"))).toEqual([])
  })
  it("a corrupt zip is zip_invalid and leaves nothing", async () => {
    const p = path.join(zips, "bad.zip")
    fs.writeFileSync(p, "garbage")
    await rejects(extractPackage(p, "m1", "job1"), "zip_invalid")
    expect(fs.readdirSync(mids)).toEqual([])
  })
  it("refuses a staging dir that is group-writable", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    fs.mkdirSync(path.join(root, "staging"), { mode: 0o700 })
    fs.chmodSync(path.join(root, "staging"), 0o770)
    await rejects(extractPackage(p, "m1", "job1"), "internal")
    expect(fs.readdirSync(mids)).toEqual([])
  })
  it("refuses a staging dir that is a symlink or not owned by us", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    fs.mkdirSync(path.join(root, "elsewhere"), { mode: 0o700 })
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, "staging"))
    await rejects(extractPackage(p, "m1", "job1"), "internal")
    fs.unlinkSync(path.join(root, "staging"))
    const uid = process.getuid!()
    fs.mkdirSync(path.join(root, "staging"), { mode: 0o700 })
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1)
    try {
      await rejects(extractPackage(p, "m1", "job1"), "internal")
    } finally {
      spy.mockRestore()
    }
  })
  it("does not trust a marker owned by another uid", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    await extractPackage(p, "m1", "job1")
    const uid = process.getuid!()
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1)
    try {
      await rejects(extractPackage(p, "m1", "job1"), "conflict")
    } finally {
      spy.mockRestore()
    }
  })
  it("does not trust a hard-linked marker", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    await extractPackage(p, "m1", "job1")
    fs.linkSync(path.join(mids, "m1/.midhub-installed-by"), path.join(root, "other-link"))
    await rejects(extractPackage(p, "m1", "job1"), "conflict")
  })
  it("normalises mode-000 dir and file entries instead of wedging", async () => {
    const p = await zip("locked.zip", [...VALID_ENTRIES, { name: "agent/locked/", mode: 0o040000 }, { name: "agent/locked/f", data: "x", mode: 0o100000 }, { name: "agent/z000", data: "x", mode: 0o100000 }])
    await extractPackage(p, "m1", "job1")
    expect(fs.statSync(path.join(mids, "m1/agent/locked")).mode & 0o7777).toBe(0o2775)
    expect(fs.statSync(path.join(mids, "m1/agent/z000")).mode & 0o777).toBe(0o664)
  })
  it("removes a leftover staging tree containing a mode-000 dir, then installs with the same job id", async () => {
    const left = path.join(root, "staging/.extract-job1")
    fs.mkdirSync(path.join(left, "a/b"), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.join(left, "a/b"), 0)
    fs.chmodSync(path.join(left, "a"), 0)
    await extractPackage(await zip("ok.zip", VALID_ENTRIES), "m1", "job1")
    expect(fs.existsSync(path.join(mids, "m1/agent/config.xml"))).toBe(true)
    expect(fs.readdirSync(path.join(root, "staging"))).toEqual([])
  })
  it("a bad zip then a good zip with the same job id succeeds", async () => {
    await rejects(extractPackage(await zip("bad.zip", [...VALID_ENTRIES, { name: "agent/l", symlinkTo: "/etc" }]), "m1", "job1"), "zip_invalid")
    await extractPackage(await zip("ok.zip", VALID_ENTRIES), "m1", "job1")
    expect(fs.existsSync(path.join(mids, "m1/agent/bin/mid.sh"))).toBe(true)
  })
})
