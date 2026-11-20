import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/helpers", () => ({ requireUser: vi.fn(async () => ({ userId: "u1", email: "a@x.com", role: "member" })) }))
const db = vi.hoisted(() => ({ mids: [] as { name: string; state: string }[] }))
vi.mock("@/lib/db/client", () => ({
  prisma: { job: { findFirst: async () => null, findMany: async () => [] }, midServer: { findUnique: async ({ where }: { where: { name: string } }) => db.mids.find((m) => m.name === where.name) ?? null } },
}))
vi.mock("@/lib/mids/status", () => ({ readServiceStatus: async () => ({ state: "inactive", pid: null, memoryBytes: null, since: null }), runSystemctl: async () => ({ code: 0, stdout: "" }) }))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ name: "m1" }) }
const get = (q: string) => GET(new Request(`http://x/api/mids/m1/files/zip?${q}`), ctx)
let root: string
const slotCount = () => (globalThis as { __midhubZipStreams?: number }).__midhubZipStreams ?? 0

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-zipr-"))
  process.env.MIDHUB_ROOT = root
  const m = path.join(root, "mids", "m1")
  fs.mkdirSync(path.join(m, "work/โฟลเดอร์"), { recursive: true })
  fs.writeFileSync(path.join(m, "work/โฟลเดอร์/a.txt"), "hi")
  fs.writeFileSync(path.join(m, "work/big.bin"), Buffer.alloc(8 * 1024 * 1024, 1))
  db.mids.length = 0
  db.mids.push({ name: "m1", state: "installed" })
  ;(globalThis as { __midhubZipStreams?: number }).__midhubZipStreams = 0
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

it("check=1 returns counts and takes no slot", async () => {
  const res = await get("dir=work&check=1")
  expect(await res.json()).toEqual({ files: 2, bytes: 8 * 1024 * 1024 + 2 })
  expect(slotCount()).toBe(0)
})

it("streams application/zip with an encoded Thai filename", async () => {
  const res = await get("dir=work&name=" + encodeURIComponent("โฟลเดอร์"))
  expect(res.headers.get("content-type")).toBe("application/zip")
  expect(res.headers.get("content-length")).toBeNull()
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("โฟลเดอร์.zip")}`)
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(22)
  expect(slotCount()).toBe(0)
})

it("a third concurrent stream gets 429; slots are freed on cancel and on finish", async () => {
  const a = await get("dir=work&name=big.bin")
  const b = await get("dir=work&name=big.bin")
  expect(slotCount()).toBe(2)
  const c = await get("dir=work&name=big.bin")
  expect(c.status).toBe(429)
  expect((await c.json()).code).toBe("busy")
  expect((await get("dir=work&name=big.bin&check=1")).status).toBe(429)
  await a.body!.cancel()
  expect(slotCount()).toBe(1)
  await b.arrayBuffer()
  expect(slotCount()).toBe(0)
  expect((await get("dir=work&name=big.bin")).status).toBe(200)
  await (await get("dir=work&name=big.bin")).body!.cancel()
})

it("errors: too_large message, not_found, invalid_filename; no slot leaked", async () => {
  expect((await get("dir=work&name=nope")).status).toBe(404)
  expect((await get("dir=work&name=..")).status).toBe(400)
  fs.truncateSync(path.join(root, "mids/m1/work/big.bin"), 1024 ** 3 + 1)
  const res = await get("dir=work")
  expect(res.status).toBe(413)
  expect((await res.json()).message).toContain("ใหญ่เกิน 1 GB")
  expect(slotCount()).toBe(0)
})
