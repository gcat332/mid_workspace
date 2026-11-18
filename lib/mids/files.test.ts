import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ mids: [] as { name: string; state: string }[] }))
vi.mock("@/lib/db/client", () => ({
  prisma: { midServer: { findUnique: async ({ where }: { where: { name: string } }) => db.mids.find((m) => m.name === where.name) ?? null } },
}))
vi.mock("@/lib/mids/status", () => ({ readServiceStatus: async () => ({ state: "inactive", pid: null, memoryBytes: null, since: null }), runSystemctl: async () => ({ code: 0, stdout: "" }) }))

import { downloadInfo, listDir, mkdir, readText, remove, rename, upload, writeText } from "./files"

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
let root: string
let m: string
const rejects = (p: Promise<unknown>, code: string, status?: number) =>
  expect(p).rejects.toMatchObject({ code, ...(status ? { status } : {}) })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-files-"))
  process.env.MIDHUB_ROOT = root
  m = path.join(root, "mids", "m1")
  for (const d of ["agent/bin", "agent/lib", "agent/jre", "agent/conf", "agent/extlib", "work"]) fs.mkdirSync(path.join(m, d), { recursive: true })
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

describe("listDir", () => {
  it("marks program dirs read-only but not agent itself; dirs first", async () => {
    const top = await listDir("m1", "")
    expect(top).toEqual([expect.objectContaining({ name: "agent", type: "dir", readOnly: false }), expect.objectContaining({ name: "work", type: "dir" })])
    const agent = await listDir("m1", "agent")
    expect(agent.find((e) => e.name === "bin")?.readOnly).toBe(true)
    expect(agent.find((e) => e.name === "extlib")?.readOnly).toBe(false)
    expect(agent.find((e) => e.name === "config.xml")).toMatchObject({ type: "file", readOnly: true })
    expect(agent.findIndex((e) => e.type === "file")).toBeGreaterThan(agent.findLastIndex((e) => e.type === "dir"))
    expect((await listDir("m1", "agent/conf")).find((e) => e.name === "wrapper-override.conf")?.readOnly).toBe(true)
    expect((await listDir("m1", "agent/bin"))[0].readOnly).toBe(true)
  })
  it("omits symlinks that escape, shows inside links as read-only", async () => {
    fs.symlinkSync("/etc", path.join(m, "work/out"))
    fs.symlinkSync("/nonexistent-zzz", path.join(m, "work/dangling"))
    fs.symlinkSync(path.join(m, "work/note.txt"), path.join(m, "work/in"))
    const names = (await listDir("m1", "work")).map((e) => e.name)
    expect(names).toEqual(["in", "note.txt"])
    expect((await listDir("m1", "work")).find((e) => e.name === "in")).toMatchObject({ type: "file", readOnly: true })
  })
  it("404 for unknown MID, path_outside for escapes", async () => {
    await rejects(listDir("zz", ""), "not_found", 404)
    await rejects(listDir("m1", "../x"), "path_outside")
  })
})

describe("readText / writeText", () => {
  it("round-trips with sha256 hash and stale detection", async () => {
    const r = await readText("m1", "work/note.txt")
    expect(r).toEqual({ content: "hello", hash: sha("hello") })
    const w = await writeText("m1", "work/note.txt", "bye", r.hash)
    expect(w.hash).toBe(sha("bye"))
    expect(fs.readFileSync(path.join(m, "work/note.txt"), "utf8")).toBe("bye")
    await rejects(writeText("m1", "work/note.txt", "x", r.hash), "stale", 409)
  })
  it("keeps the inode (in-place write)", async () => {
    const p = path.join(m, "work/note.txt")
    const ino = fs.statSync(p).ino
    await writeText("m1", "work/note.txt", "z", sha("hello"))
    expect(fs.statSync(p).ino).toBe(ino)
  })
  it("refuses binary and >2MB", async () => {
    fs.writeFileSync(path.join(m, "work/b.bin"), Buffer.from([1, 0, 2]))
    await rejects(readText("m1", "work/b.bin"), "not_text")
    fs.writeFileSync(path.join(m, "work/big.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 97))
    await rejects(readText("m1", "work/big.txt"), "too_large", 413)
    await rejects(writeText("m1", "work/note.txt", "a".repeat(2 * 1024 * 1024 + 1), sha("hello")), "too_large", 413)
  })
  it("write via traversal -> path_outside; into program dir -> read_only", async () => {
    await rejects(writeText("m1", "../../etc/x", "x", "h"), "path_outside")
    await rejects(writeText("m1", "agent/bin/mid.sh", "x", sha("#!/bin/sh\n")), "read_only", 403)
  })
  it("config files go through the config tab", async () => {
    await rejects(writeText("m1", "agent/config.xml", "x", sha("<parameters/>")), "use_config_tab", 403)
    await rejects(writeText("m1", "agent/conf/wrapper-override.conf", "x", sha("a=1\n")), "use_config_tab", 403)
    await rejects(readText("m1", "agent/config.xml"), "use_config_tab", 403)
    await rejects(downloadInfo("m1", "agent/config.xml"), "use_config_tab", 403)
  })
})

describe("upload", () => {
  it("creates files 0664 (group write) and overwrites extlib jars", async () => {
    await upload("m1", "work", "a.txt", Buffer.from("x"))
    expect(fs.statSync(path.join(m, "work/a.txt")).mode & 0o777).toBe(0o664)
    await upload("m1", "agent/extlib", "x.jar", Buffer.from("v1"))
    await upload("m1", "agent/extlib", "x.jar", Buffer.from("v2"))
    expect(fs.readFileSync(path.join(m, "agent/extlib/x.jar"), "utf8")).toBe("v2")
  })
  it("rejects program dirs, bad names, >50MB, config files", async () => {
    await rejects(upload("m1", "agent/bin", "a", Buffer.from("x")), "read_only", 403)
    await rejects(upload("m1", "work", "../x.jar", Buffer.from("x")), "invalid_request", 400)
    await rejects(upload("m1", "work", "a\0b", Buffer.from("x")), "invalid_request", 400)
    await rejects(upload("m1", "work", "a".repeat(256), Buffer.from("x")), "invalid_request", 400)
    await rejects(upload("m1", "work", "big", Buffer.alloc(51 * 1024 * 1024)), "too_large", 413)
    await rejects(upload("m1", "agent", "config.xml", Buffer.from("x")), "use_config_tab", 403)
  })
  it("does not write through a symlink entry", async () => {
    fs.symlinkSync(path.join(m, "work/note.txt"), path.join(m, "work/ln"))
    await rejects(upload("m1", "work", "ln", Buffer.from("x")), "conflict", 409)
    expect(fs.readFileSync(path.join(m, "work/note.txt"), "utf8")).toBe("hello")
  })
})

describe("mkdir", () => {
  it("creates 0775 dirs, refuses existing and program dirs", async () => {
    await mkdir("m1", "work", "d")
    expect(fs.statSync(path.join(m, "work/d")).mode & 0o777).toBe(0o775)
    await rejects(mkdir("m1", "work", "d"), "conflict", 409)
    await rejects(mkdir("m1", "agent/bin", "d"), "read_only", 403)
    await rejects(mkdir("m1", "work", "a/b"), "invalid_request")
  })
})

describe("rename", () => {
  it("renames within the parent, refuses collisions and bad names", async () => {
    expect(await rename("m1", "work/note.txt", "n2.txt")).toEqual({ to: "work/n2.txt" })
    expect(fs.existsSync(path.join(m, "work/n2.txt"))).toBe(true)
    fs.writeFileSync(path.join(m, "work/o"), "")
    await rejects(rename("m1", "work/o", "n2.txt"), "conflict", 409)
    for (const bad of ["a/b", "..", ".", "", "a\\b"]) await rejects(rename("m1", "work/o", bad), "invalid_request", 400)
  })
  it("refuses agent, root, program dirs, config files, and containers of them", async () => {
    await rejects(rename("m1", "agent", "x"), "read_only", 403)
    await rejects(rename("m1", "", "x"), "read_only", 403)
    await rejects(rename("m1", "agent/bin", "x"), "read_only", 403)
    await rejects(rename("m1", "agent/config.xml", "x"), "use_config_tab", 403)
    await rejects(rename("m1", "agent/conf", "x"), "use_config_tab", 403)
    await rejects(rename("m1", "agent/extlib", "jre"), "read_only", 403)
  })
})

describe("remove", () => {
  it("removes files and dirs recursively", async () => {
    fs.mkdirSync(path.join(m, "work/d/e"), { recursive: true })
    fs.writeFileSync(path.join(m, "work/d/e/f"), "")
    await remove("m1", "work/d")
    expect(fs.existsSync(path.join(m, "work/d"))).toBe(false)
    await remove("m1", "work/note.txt")
    await rejects(remove("m1", "work/note.txt"), "not_found", 404)
  })
  it("refuses the root, agent, program dirs and config files", async () => {
    await rejects(remove("m1", ""), "read_only", 403)
    await rejects(remove("m1", "agent"), "read_only", 403)
    await rejects(remove("m1", "agent/bin"), "read_only", 403)
    await rejects(remove("m1", "agent/bin/mid.sh"), "read_only", 403)
    await rejects(remove("m1", "agent/config.xml"), "use_config_tab", 403)
    expect(fs.existsSync(path.join(m, "agent/config.xml"))).toBe(true)
  })
  it("deleting a symlink removes only the link", async () => {
    const target = path.join(m, "work/tdir")
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, "keep"), "k")
    fs.symlinkSync(target, path.join(m, "work/lnk"))
    await remove("m1", "work/lnk")
    expect(fs.existsSync(path.join(m, "work/lnk"))).toBe(false)
    expect(fs.readFileSync(path.join(target, "keep"), "utf8")).toBe("k")
  })
  it("a symlink to a program dir can be removed without touching it", async () => {
    fs.symlinkSync(path.join(m, "agent/bin"), path.join(m, "work/binlink"))
    await remove("m1", "work/binlink")
    expect(fs.existsSync(path.join(m, "agent/bin/mid.sh"))).toBe(true)
  })
})

describe("downloadInfo", () => {
  it("returns the real file, rejects dirs", async () => {
    expect(await downloadInfo("m1", "work/note.txt")).toMatchObject({ size: 5, filename: "note.txt" })
    await rejects(downloadInfo("m1", "work"), "invalid_request", 400)
  })
})
