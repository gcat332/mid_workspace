import http from "node:http"
import type { AddressInfo } from "node:net"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-pkg-"))
const root = path.join(dir, "root")
process.env.MIDHUB_ROOT = root
process.env.DATABASE_URL = `file:${path.join(dir, "t.db")}`

const BS = "australia-02-11-2026__patch7-11-10-2026_11-12-2026_0100"
const BS2 = "australia-02-11-2026__patch6-11-03-2026_11-05-2026_0100"
const BS3 = "australia-02-11-2026__patch5-10-20-2026_10-22-2026_0100"
const BS4 = "australia-02-11-2026__patch4-10-10-2026_10-12-2026_0100"
const body = Buffer.alloc(300_000, 7)

let hits = 0
let mode: "ok" | "short" | "404" | "slow" | "redirect-bad" = "ok"
let server: http.Server
let base: string
const urlFor = (b: string) => `${base}/${b}.zip`

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env }, stdio: "pipe" })
  server = http.createServer((req, res) => {
    hits++
    if (mode === "404") { res.writeHead(404).end(); return }
    if (mode === "redirect-bad") { res.writeHead(302, { location: "http://127.0.0.1:1/x" }).end(); return }
    if (mode === "short") { res.writeHead(200, { "content-length": String(body.length) }); res.write(body.subarray(0, 1000)); setTimeout(() => res.destroy(), 20); return }
    if (mode === "slow") { res.writeHead(200, { "content-length": String(body.length) }); res.write(body.subarray(0, 10)); return }
    res.writeHead(200, { "content-length": String(body.length) })
    setTimeout(() => res.end(body), 30)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60000)
afterAll(async () => {
  server.closeAllConnections()
  server.close()
  const { prisma } = await import("@/lib/db/client")
  await prisma.$disconnect()
  fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  hits = 0
  mode = "ok"
  fs.rmSync(path.join(root, "packages"), { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__midhubDiskCache
})

const pkgDir = () => path.join(root, "packages")

it("downloads, writes final file, leaves no .part, reports progress", async () => {
  const { ensurePackage, packagePath } = await import("./packages")
  const seen: number[] = []
  const p = await ensurePackage(BS, { urlFor, onProgress: (d) => seen.push(d) })
  expect(p).toBe(packagePath(BS))
  expect(p).toBe(path.join(root, "packages", `${BS}.zip`))
  expect(fs.readFileSync(p).equals(body)).toBe(true)
  expect(fs.readdirSync(pkgDir())).toEqual([`${BS}.zip`])
  expect(seen.at(-1)).toBe(body.length)
})

it("short body -> package_download, no final and no .part", async () => {
  mode = "short"
  const { ensurePackage } = await import("./packages")
  await expect(ensurePackage(BS, { urlFor })).rejects.toMatchObject({ code: "package_download" })
  expect(fs.readdirSync(pkgDir())).toEqual([])
})

it("existing final file -> no HTTP request", async () => {
  const { ensurePackage, packagePath } = await import("./packages")
  fs.mkdirSync(pkgDir(), { recursive: true })
  fs.writeFileSync(packagePath(BS), "x")
  expect(await ensurePackage(BS, { urlFor })).toBe(packagePath(BS))
  expect(hits).toBe(0)
})

it("a leftover .part is overwritten, not used", async () => {
  const { ensurePackage, packagePath } = await import("./packages")
  fs.mkdirSync(pkgDir(), { recursive: true })
  fs.writeFileSync(packagePath(BS) + ".part", Buffer.alloc(900_000, 1))
  await ensurePackage(BS, { urlFor })
  expect(fs.readFileSync(packagePath(BS)).equals(body)).toBe(true)
})

it("404 -> package_not_found; redirect to a non service-now host -> package_download", async () => {
  const { ensurePackage } = await import("./packages")
  mode = "404"
  await expect(ensurePackage(BS, { urlFor })).rejects.toMatchObject({ code: "package_not_found" })
  mode = "redirect-bad"
  await expect(ensurePackage(BS, { urlFor })).rejects.toMatchObject({ code: "package_download" })
  expect(fs.readdirSync(pkgDir())).toEqual([])
})

it("concurrent callers for one buildstamp share a single download", async () => {
  const { ensurePackage } = await import("./packages")
  const [a, b] = await Promise.all([ensurePackage(BS, { urlFor }), ensurePackage(BS, { urlFor })])
  expect(a).toBe(b)
  expect(hits).toBe(1)
})

it("caller abort stops the download and removes the .part", async () => {
  mode = "slow"
  const { ensurePackage } = await import("./packages")
  const ac = new AbortController()
  const pr = ensurePackage(BS, { urlFor, signal: ac.signal })
  setTimeout(() => ac.abort(), 150)
  await expect(pr).rejects.toBeTruthy()
  expect(fs.readdirSync(pkgDir())).toEqual([])
})

it("gcPackages keeps installed/queued/failed buildstamps, deletes unused and stale .part, keeps fresh .part", async () => {
  const { gcPackages, packagePath, listPackages } = await import("./packages")
  const { prisma } = await import("@/lib/db/client")
  await prisma.midServer.create({ data: { name: "m1", dir: "/x", serviceName: "s", version: BS, createdBy: "u" } })
  await prisma.midServer.create({ data: { name: "m2", dir: "/x", serviceName: "s", version: BS4, createdBy: "u", removedAt: new Date() } })
  await prisma.job.create({ data: { midName: "m3", kind: "install", stage: "download", status: "failed", params: JSON.stringify({ buildstamp: BS2 }), journalPath: "/j", createdBy: "u" } })
  fs.mkdirSync(pkgDir(), { recursive: true })
  for (const b of [BS, BS2, BS3, BS4]) fs.writeFileSync(packagePath(b), "z")
  const stale = packagePath(BS3) + ".part"
  const fresh = packagePath(BS) + ".part"
  fs.writeFileSync(stale, "p")
  fs.writeFileSync(fresh, "p")
  const old = new Date(Date.now() - 2 * 86400_000)
  fs.utimesSync(stale, old, old)
  const deleted = (await gcPackages()).sort()
  expect(deleted).toEqual([`${BS3}.zip`, `${BS3}.zip.part`, `${BS4}.zip`].sort())
  expect((await listPackages()).map((x) => x.buildstamp).sort()).toEqual([BS, BS2].sort())
  expect(fs.existsSync(fresh)).toBe(true)
})

it("gcPackages never deletes a package being downloaded", async () => {
  mode = "slow"
  const { gcPackages, ensurePackage } = await import("./packages")
  const ac = new AbortController()
  const pr = ensurePackage(BS, { urlFor, signal: ac.signal }).catch(() => {})
  await new Promise((r) => setTimeout(r, 100))
  const part = path.join(pkgDir(), `${BS}.zip.part`)
  const old = new Date(Date.now() - 2 * 86400_000)
  fs.utimesSync(part, old, old)
  expect(await gcPackages()).toEqual([])
  expect(fs.existsSync(part)).toBe(true)
  ac.abort()
  await pr
})

it("diskStatus reports free/total and du usage (0 for missing dirs), cached", async () => {
  const { diskStatus } = await import("./packages")
  fs.mkdirSync(path.join(root, "mids"), { recursive: true })
  fs.writeFileSync(path.join(root, "mids", "f"), Buffer.alloc(50_000))
  const d = await diskStatus()
  expect(d.freeBytes).toBeGreaterThan(0)
  expect(d.totalBytes).toBeGreaterThanOrEqual(d.freeBytes)
  expect(d.usage!.mids).toBeGreaterThanOrEqual(50_000)
  expect(d.usage!.archive).toBe(0)
  fs.writeFileSync(path.join(root, "mids", "g"), Buffer.alloc(500_000))
  expect((await diskStatus()).usage!.mids).toBe(d.usage!.mids)
})
