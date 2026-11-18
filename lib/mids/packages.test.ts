import http from "node:http"
import type { AddressInfo } from "node:net"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"

const duHook = vi.hoisted(() => ({ fn: null as null | ((real: (...a: unknown[]) => unknown, args: unknown[]) => unknown) }))
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>()
  return { ...real, execFile: (...a: unknown[]) => (duHook.fn ? duHook.fn(real.execFile as never, a) : (real.execFile as never as (...x: unknown[]) => unknown)(...a)) }
})

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
let mode: "ok" | "short" | "404" | "slow" | "slow-once" | "redirect-bad" | "redirect-apex" | "redirect-port" = "ok"
let server: http.Server
let base: string
const urlFor = (b: string) => `${base}/${b}.zip`

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env }, stdio: "pipe" })
  server = http.createServer((req, res) => {
    hits++
    if (mode === "404") { res.writeHead(404).end(); return }
    if (mode === "redirect-bad") { res.writeHead(302, { location: "http://127.0.0.1:1/x" }).end(); return }
    if (mode === "redirect-apex") { res.writeHead(302, { location: "https://service-now.com/x" }).end(); return }
    if (mode === "redirect-port") { res.writeHead(302, { location: "https://a.service-now.com:8443/x" }).end(); return }
    if (mode === "slow-once") { if (hits === 1) { res.writeHead(200, { "content-length": String(body.length) }); res.write(body.subarray(0, 10)); return } }
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
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("midhub.packages.du")]
  duHook.fn = null
  server?.closeAllConnections()
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

const until = async <T>(f: () => Promise<T | null>): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = await f()
    if (v) return v
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error("until")
}

it("diskStatus: cold cache returns statfs at once with usage null, refreshes in background, then caches", async () => {
  const { diskStatus } = await import("./packages")
  fs.mkdirSync(path.join(root, "mids"), { recursive: true })
  fs.writeFileSync(path.join(root, "mids", "f"), Buffer.alloc(50_000))
  const first = await diskStatus()
  expect(first.freeBytes).toBeGreaterThan(0)
  expect(first.totalBytes).toBeGreaterThanOrEqual(first.freeBytes!)
  expect(first.usage).toBeNull()
  const d = await until(async () => (await diskStatus()).usage)
  expect(d.mids).toBeGreaterThanOrEqual(50_000)
  expect(d.archive).toBe(0)
  fs.writeFileSync(path.join(root, "mids", "g"), Buffer.alloc(500_000))
  expect((await diskStatus()).usage!.mids).toBe(d.mids)
})

it("a slow du does not delay diskStatus and is not spawned twice concurrently", async () => {
  const { diskStatus } = await import("./packages")
  fs.mkdirSync(path.join(root, "mids"), { recursive: true })
  let running = 0
  let maxRunning = 0
  let spawned = 0
  duHook.fn = (real, args) => {
    spawned++
    running++
    maxRunning = Math.max(maxRunning, running)
    const cb = args[args.length - 1] as (...x: unknown[]) => void
    setTimeout(() => (real as (...x: unknown[]) => unknown)(...args.slice(0, -1), (...r: unknown[]) => { running--; cb(...r) }), 500)
    return undefined
  }
  const t0 = Date.now()
  const rs = await Promise.all([diskStatus(), diskStatus(), diskStatus()])
  expect(Date.now() - t0).toBeLessThan(300)
  expect(rs.every((r) => r.usage === null && r.freeBytes! > 0)).toBe(true)
  await diskStatus()
  expect(spawned).toBe(1) // only "mids" exists; one du, shared by all callers
  expect(maxRunning).toBe(1)
  await until(async () => (await diskStatus()).usage)
})

it("waiter aborting rejects promptly while the owner keeps downloading", async () => {
  mode = "slow"
  const { ensurePackage } = await import("./packages")
  const owner = ensurePackage(BS, { urlFor }).catch((e) => e)
  await new Promise((r) => setTimeout(r, 80))
  const ac = new AbortController()
  const w = ensurePackage(BS, { urlFor, signal: ac.signal })
  setTimeout(() => ac.abort(new Error("cancelled")), 50)
  const t0 = Date.now()
  await expect(w).rejects.toThrow("cancelled")
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(fs.existsSync(path.join(pkgDir(), `${BS}.zip.part`))).toBe(true) // owner still going
  expect(hits).toBe(1)
  server.closeAllConnections()
  await owner
})

it("owner aborting hands the download to a live waiter, which completes", async () => {
  mode = "slow-once"
  const { ensurePackage, packagePath } = await import("./packages")
  const oc = new AbortController()
  const owner = ensurePackage(BS, { urlFor, signal: oc.signal })
  const ownerRes = owner.catch((e) => e)
  await new Promise((r) => setTimeout(r, 80))
  const w = ensurePackage(BS, { urlFor })
  setTimeout(() => oc.abort(new Error("owner-cancelled")), 50)
  expect(((await ownerRes) as Error).message).toBe("owner-cancelled")
  expect(await w).toBe(packagePath(BS))
  expect(fs.readFileSync(packagePath(BS)).equals(body)).toBe(true)
})

it("a waiter receives progress callbacks", async () => {
  const { ensurePackage } = await import("./packages")
  const owner = ensurePackage(BS, { urlFor })
  const seen: number[] = []
  await ensurePackage(BS, { urlFor, onProgress: (d) => seen.push(d) })
  await owner
  expect(seen.at(-1)).toBe(body.length)
})

it("redirects to the apex domain or a non-default port are rejected", async () => {
  const { ensurePackage } = await import("./packages")
  mode = "redirect-apex"
  await expect(ensurePackage(BS, { urlFor })).rejects.toMatchObject({ code: "package_download" })
  mode = "redirect-port"
  await expect(ensurePackage(BS, { urlFor })).rejects.toMatchObject({ code: "package_download" })
})

it("a final path that is a symlink is not treated as a cached package", async () => {
  const { ensurePackage, packagePath } = await import("./packages")
  fs.mkdirSync(pkgDir(), { recursive: true })
  fs.writeFileSync(path.join(dir, "elsewhere"), "x")
  fs.symlinkSync(path.join(dir, "elsewhere"), packagePath(BS))
  await ensurePackage(BS, { urlFor })
  expect(hits).toBe(1)
})

it("gcPackages continues after a per-entry rm failure", async () => {
  const { gcPackages, packagePath } = await import("./packages")
  fs.mkdirSync(pkgDir(), { recursive: true })
  fs.mkdirSync(packagePath(BS2) + ".part") // rm without recursive fails on a directory
  fs.utimesSync(packagePath(BS2) + ".part", new Date(0), new Date(0))
  fs.writeFileSync(packagePath(BS3), "z")
  expect(await gcPackages()).toEqual([`${BS3}.zip`])
})
