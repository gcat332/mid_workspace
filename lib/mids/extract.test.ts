import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MAX_UNCOMPRESSED, checkListing, extractPackage, validateZip } from "./extract"
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
    fs.mkdirSync(path.join(mids, ".extract-job3/stale"), { recursive: true })
    await extractPackage(p, "m2", "job3")
    expect(fs.existsSync(path.join(mids, "m2/agent/config.xml"))).toBe(true)
    expect(fs.existsSync(path.join(mids, "m2/stale"))).toBe(false)
  })
  it("removes the temp dir when aborted", async () => {
    const p = await zip("ok.zip", VALID_ENTRIES)
    const ac = new AbortController()
    ac.abort()
    await expect(extractPackage(p, "m1", "job1", ac.signal)).rejects.toThrow()
    expect(fs.readdirSync(mids)).toEqual([])
  })
  it("a corrupt zip fails unzip -> zip_invalid and cleans up", async () => {
    const p = path.join(zips, "bad.zip")
    fs.writeFileSync(p, "garbage")
    await rejects(extractPackage(p, "m1", "job1"), "zip_invalid")
    expect(fs.readdirSync(mids)).toEqual([])
  })
})
