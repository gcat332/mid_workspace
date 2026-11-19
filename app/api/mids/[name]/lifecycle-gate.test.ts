// Server-side lifecycle gate (final review M1): browser writes on a MID are refused unless it is `installed` or
// `error` (a failed install stays stoppable and fixable) with no active lifecycle job. Real SQLite (project migrations), real routes, real config-service and files
// over a temp MID tree; only auth, audit, the root helper and systemctl are faked.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { sha256 } from "@/lib/hash"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-gate-"))
const dbUrl = `file:${path.join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
const root = path.join(dir, "root")
process.env.MIDHUB_ROOT = root

vi.mock("@/lib/auth/helpers", () => ({ requireUser: vi.fn(async () => ({ userId: "u1", email: "a@x.com", role: "member", authAt: 0 })) }))
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }))
const callHelper = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
vi.mock("@/lib/helper/client", () => ({ callHelper }))
vi.mock("@/lib/mids/status", () => ({
  readServiceStatus: vi.fn(async () => ({ state: "stopped", pid: null, memoryBytes: null, since: null })),
  runSystemctl: vi.fn(async () => ({ code: 0, stdout: "LoadState=loaded\n" })),
  readHostMemory: vi.fn(async () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 })),
}))

const XML = `<parameters>
  <parameter name="url" value="https://acme.service-now.com/"/>
  <parameter name="name" value="mid-one"/>
  <parameter name="mid.instance.username" value="svc"/>
</parameters>
`
const WRAP = "wrapper.java.maxmemory=1024\n"
const NOTE = "hello\n"
const midDir = path.join(root, "mids", "m1", "agent")
const wrapPath = path.join(midDir, "conf", "wrapper-override.conf")
const notePath = path.join(midDir, "note.txt")
const ctx = { params: Promise.resolve({ name: "m1" }) }

type Prisma = (typeof import("@/lib/db/client"))["prisma"]
let prisma: Prisma

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  prisma = (await import("@/lib/db/client")).prisma
}, 60000)
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function setMid(state: string, job?: { kind: string; stage: string; status: string }) {
  await prisma.job.deleteMany({})
  await prisma.midServer.deleteMany({})
  await prisma.midServer.create({ data: { name: "m1", dir: path.join(root, "mids", "m1"), serviceName: "midhub-mid-m1.service", heapMb: 1024, state, createdBy: "u1" } })
  if (job) await prisma.job.create({ data: { midName: "m1", ...job, params: "{}", journalPath: path.join(dir, "j.log"), createdBy: "u1" } })
}

beforeEach(() => {
  fs.rmSync(path.join(root, "mids"), { recursive: true, force: true })
  fs.mkdirSync(path.join(midDir, "conf"), { recursive: true })
  fs.writeFileSync(path.join(midDir, "config.xml"), XML)
  fs.writeFileSync(wrapPath, WRAP)
  fs.writeFileSync(notePath, NOTE)
  callHelper.mockClear()
})

const json = (method: string, url: string, body: unknown) =>
  new Request(`http://x${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const heapSave = () =>
  json("PUT", "/api/mids/m1/config", {
    baseHash: sha256(XML), wrapperBaseHash: sha256(WRAP),
    form: { url: "https://acme.service-now.com/", username: "svc", midName: "mid-one", useProxy: false, proxyHost: "", proxyPort: "", proxyUser: "", heapMb: 2048 },
  })

it("config heap save during an active uninstall -> 409 job_active, no helper installUnit, file untouched", async () => {
  const { PUT } = await import("./config/route")
  await setMid("uninstalling", { kind: "uninstall", stage: "removeUnit", status: "running" })
  const res = await PUT(heapSave(), ctx)
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body.code).toBe("job_active")
  expect(body.message).toContain("ถอนบริการ (systemd)") // names the running stage
  expect(callHelper).not.toHaveBeenCalled()
  expect(fs.readFileSync(wrapPath, "utf8")).toBe(WRAP)

  // Control: the same request on a settled MID reaches the helper (so the assertion above is not vacuous).
  await setMid("installed")
  expect((await PUT(heapSave(), ctx)).status).toBe(200)
  expect(callHelper).toHaveBeenCalledWith({ op: "installUnit", name: "m1", heapMb: 2048 })
})

it("config rollback is gated too (it can rewrite the unit through installUnit)", async () => {
  const { POST } = await import("./config/backups/[id]/route")
  await setMid("installing", { kind: "install", stage: "configure", status: "queued" })
  const res = await POST(new Request("http://x/api/mids/m1/config/backups/b1", { method: "POST" }), { params: Promise.resolve({ name: "m1", id: "b1" }) })
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe("job_active")
})

it("file write / mkdir / delete on an `error` MID with no active job -> allowed (a failed install stays fixable)", async () => {
  const files = await import("./files/route")
  await setMid("error", { kind: "install", stage: "waitConnected", status: "failed" })
  const put = await files.PUT(json("PUT", "/api/mids/m1/files", { path: "agent/note.txt", content: "changed\n", baseHash: sha256(NOTE) }), ctx)
  expect(put.status).toBe(200)
  expect(fs.readFileSync(notePath, "utf8")).toBe("changed\n")
  expect((await files.POST(json("POST", "/api/mids/m1/files", { op: "mkdir", parent: "agent", name: "x" }), ctx)).status).toBe(200)
  expect((await files.DELETE(new Request("http://x/api/mids/m1/files?path=agent/note.txt", { method: "DELETE" }), ctx)).status).toBe(200)
})

it("file write / delete / mkdir on an `installing` MID -> 409; reads stay allowed", async () => {
  const files = await import("./files/route")
  await setMid("installing")
  const put = await files.PUT(json("PUT", "/api/mids/m1/files", { path: "agent/note.txt", content: "changed\n", baseHash: sha256(NOTE) }), ctx)
  expect(put.status).toBe(409)
  const body = await put.json()
  expect(body.code).toBe("job_active")
  expect(body.message).toContain("กำลังติดตั้ง")
  expect(fs.readFileSync(notePath, "utf8")).toBe(NOTE)
  expect((await files.DELETE(new Request("http://x/api/mids/m1/files?path=agent/note.txt", { method: "DELETE" }), ctx)).status).toBe(409)
  expect(fs.existsSync(notePath)).toBe(true)
  expect((await files.POST(json("POST", "/api/mids/m1/files", { op: "mkdir", parent: "agent", name: "x" }), ctx)).status).toBe(409)
  expect(fs.existsSync(path.join(midDir, "x"))).toBe(false)
  const read = await files.GET(new Request("http://x/api/mids/m1/files?path=agent/note.txt&content=1"), ctx)
  expect(read.status).toBe(200)
  expect((await read.json()).content).toBe(NOTE)
})

it("upload during an active job -> 409 before the body is read", async () => {
  const { POST } = await import("./files/route")
  await setMid("installed", { kind: "install", stage: "waitConnected", status: "running" })
  const req = new Request("http://x/api/mids/m1/files", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "100" }, body: "--x--" })
  const formData = vi.spyOn(req, "formData")
  const res = await POST(req, ctx)
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe("job_active")
  expect(formData).not.toHaveBeenCalled()
})

it("start on an installed MID with no job -> allowed; stop on a failed install (`error`) -> allowed; stop during an install job -> 409", async () => {
  const { POST } = await import("./actions/route")
  await setMid("installed")
  const ok = await POST(json("POST", "/api/mids/m1/actions", { action: "start" }), ctx)
  expect(ok.status).toBe(200)
  expect(callHelper).toHaveBeenCalledWith({ op: "start", name: "m1" })

  callHelper.mockClear()
  await setMid("error", { kind: "install", stage: "waitConnected", status: "failed" })
  expect((await POST(json("POST", "/api/mids/m1/actions", { action: "stop" }), ctx)).status).toBe(200)
  expect(callHelper).toHaveBeenCalledWith({ op: "stop", name: "m1" })

  callHelper.mockClear()
  await setMid("installing", { kind: "install", stage: "start", status: "running" })
  const busy = await POST(json("POST", "/api/mids/m1/actions", { action: "stop" }), ctx)
  expect(busy.status).toBe(409)
  expect((await busy.json()).code).toBe("job_active")
  expect(callHelper).not.toHaveBeenCalled()
})

it.each(["removed", "uninstalling"])("heap save on a `%s` MID (no active job) -> 409 job_active, no installUnit", async (state) => {
  const { PUT } = await import("./config/route")
  await setMid(state)
  const res = await PUT(heapSave(), ctx)
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe("job_active")
  expect(callHelper).not.toHaveBeenCalled()
  expect(fs.readFileSync(wrapPath, "utf8")).toBe(WRAP)
})

it("heap save on an `error` MID with no active job -> allowed (reaches installUnit)", async () => {
  const { PUT } = await import("./config/route")
  await setMid("error")
  expect((await PUT(heapSave(), ctx)).status).toBe(200)
  expect(callHelper).toHaveBeenCalledWith({ op: "installUnit", name: "m1", heapMb: 2048 })
})

it("an `error` MID with an active job is still refused", async () => {
  const { PUT } = await import("./files/route")
  await setMid("error", { kind: "cancel_install", stage: "stop", status: "queued" })
  expect((await PUT(json("PUT", "/api/mids/m1/files", { path: "agent/note.txt", content: "x", baseHash: sha256(NOTE) }), ctx)).status).toBe(409)
})

it("an unknown MID is 404", async () => {
  const { PUT } = await import("./files/route")
  await prisma.job.deleteMany({})
  await prisma.midServer.deleteMany({})
  expect((await PUT(json("PUT", "/api/mids/m1/files", { path: "agent/note.txt", content: "x", baseHash: sha256(NOTE) }), ctx)).status).toBe(404)
})
