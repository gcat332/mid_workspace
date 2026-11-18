import { it, expect, vi, beforeAll, afterAll, beforeEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-lifecycle-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = join(dir, "root")
process.env.JWT_SECRET = "x".repeat(40)
process.env.ADMIN_EMAIL = "a@x.com"
process.env.ADMIN_PASSWORD = "pw"
process.env.MIDHUB_VAULT_KEY = Buffer.alloc(32, 7).toString("base64")

let role: "admin" | "member" = "member"
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireUser: vi.fn(async () => ({ userId: "u1", email: "m@x.com", role })),
  requireAdmin: vi.fn(async () => {
    if (role !== "admin") throw new Response(JSON.stringify({ code: "forbidden" }), { status: 403 })
    return { userId: "u1", email: "m@x.com", role }
  }),
}))
vi.mock("@/lib/mids/status", () => ({
  readServiceStatus: async () => ({ state: "inactive", pid: null, memoryBytes: null, since: null }),
  runSystemctl: async () => ({ code: 0, stdout: "" }),
}))

const BS = "australia-02-11-2026__patch7-hotfix1-10-01-2026_11-05-2026_1234"
const PW = "instance-secret-pw"
const PROXY_PW = "proxy-secret-pw"
let prisma: typeof import("@/lib/db/client").prisma
let eng: typeof import("@/lib/jobs/engine")
let instanceId: string
let noCredId: string

const req = (method: string, body?: unknown, url = "http://x/api/mids") =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const post = async (body: unknown) => (await import("./route")).POST(req("POST", body))
const del = async (name: string, body: unknown) =>
  (await import("./[name]/route")).DELETE(req("DELETE", body), { params: Promise.resolve({ name }) })

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
  eng = await import("@/lib/jobs/engine")
  const { encryptSecret } = await import("@/lib/vault")
  const i = await prisma.instance.create({
    data: { url: "https://demo.service-now.com/", label: "demo", createdBy: "t", midUser: "mid", midPasswordEnc: encryptSecret(PW), buildstamp: BS },
  })
  instanceId = i.id
  noCredId = (await prisma.instance.create({ data: { url: "https://nocred.service-now.com/", label: "n", createdBy: "t" } })).id
})
afterAll(async () => {
  eng.__abortForTests()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  role = "member"
  eng.__abortForTests()
  eng.__resetForTests()
  // Stages that park until the engine aborts, so jobs stay "running" and never touch the host.
  const park = { name: "park", run: (ctx: { signal: AbortSignal }) => new Promise<void>((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))) }
  for (const k of ["install", "clone", "uninstall", "cancel_install"] as const) eng.registerKind(k, [park])
  await prisma.job.deleteMany()
  await prisma.midServer.deleteMany()
})

describe("POST /api/mids", () => {
  it("202, queues a job, row installing, proxy password only encrypted", async () => {
    const res = await post({ instanceId, name: "m1", proxy: { host: "proxy.corp", port: 3128, user: "u", password: PROXY_PW } })
    expect(res.status).toBe(202)
    const text = JSON.stringify(await res.clone().json())
    const { jobId } = await res.json()
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } })
    const row = await prisma.midServer.findUniqueOrThrow({ where: { name: "m1" } })
    expect(job.kind).toBe("install")
    expect(job.midId).toBe(row.id)
    expect(row).toMatchObject({ state: "installing", instanceId, heapMb: 1024 })
    const p = JSON.parse(job.params)
    expect(p).toMatchObject({ buildstamp: BS, snName: "midhub-m1", logFiles: 3 })
    expect(p.proxy.passwordEnc).toBeTruthy()
    const audit = JSON.stringify(await prisma.auditLog.findMany())
    for (const s of [PW, PROXY_PW]) for (const hay of [text, job.params, audit]) expect(hay).not.toContain(s)
    expect(audit).toContain("job.create")
  })

  it("clone kind when cloneFrom exists; unknown/self cloneFrom rejected", async () => {
    await prisma.midServer.create({ data: { name: "src", dir: "/x", serviceName: "s", state: "installed", createdBy: "t" } })
    const ok = await post({ instanceId, name: "c1", cloneFrom: "src" })
    expect(ok.status).toBe(202)
    expect((await prisma.job.findFirstOrThrow({ where: { midName: "c1" } })).kind).toBe("clone")
    expect((await post({ instanceId, name: "c2", cloneFrom: "nope" })).status).toBe(404)
    expect((await post({ instanceId, name: "c3", cloneFrom: "c3" })).status).toBe(400)
  })

  it("same name concurrently: one 202, one 409", async () => {
    const rs = await Promise.all([post({ instanceId, name: "dup" }), post({ instanceId, name: "dup" })])
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409])
    expect(await prisma.job.count({ where: { midName: "dup" } })).toBe(1)
  })

  it("revives a removed row", async () => {
    const old = await prisma.midServer.create({ data: { name: "gone", dir: "/x", serviceName: "s", state: "removed", removedAt: new Date(), version: "1", heapMb: 512, createdBy: "old" } })
    const res = await post({ instanceId, name: "gone", heapMb: 2048 })
    expect(res.status).toBe(202)
    const row = await prisma.midServer.findUniqueOrThrow({ where: { name: "gone" } })
    expect(row).toMatchObject({ id: old.id, state: "installing", heapMb: 2048, version: null, removedAt: null, createdBy: "m@x.com" })
  })

  it("rolls the row back when createJob fails (new and revived)", async () => {
    await prisma.job.create({ data: { id: "j-old", midName: "busy", kind: "install", stage: "park", status: "running", params: "{}", journalPath: "x", createdBy: "t" } })
    // new row case: a job is active for the name but no row exists
    expect((await post({ instanceId, name: "busy" })).status).toBe(409)
    expect(await prisma.midServer.count({ where: { name: "busy" } })).toBe(0)
    // revived case
    await prisma.midServer.create({ data: { name: "busy", dir: "/x", serviceName: "s", state: "removed", removedAt: new Date(), version: "9", heapMb: 512, createdBy: "old" } })
    expect((await post({ instanceId, name: "busy" })).status).toBe(409)
    expect(await prisma.midServer.findUniqueOrThrow({ where: { name: "busy" } })).toMatchObject({ state: "removed", version: "9", heapMb: 512, createdBy: "old" })
  })

  it("validates input", async () => {
    const bad: unknown[] = [
      { instanceId, name: "A" },
      { instanceId, name: "ok1", snName: "bad name" },
      { instanceId, name: "ok1", heapMb: 10 },
      { instanceId, name: "ok1", heapMb: 1.5 },
      { instanceId, name: "ok1", logFiles: 11 },
      { instanceId, name: "ok1", proxy: { host: "http://p", port: 1 } },
      { instanceId, name: "ok1", proxy: { host: "p", port: 0 } },
      { instanceId, name: "ok1", proxy: { host: "p", port: 1, password: "a\u0001b" } },
      { instanceId, name: "ok1", proxy: { host: "p", port: 1, user: "u".repeat(101) } },
      { instanceId, name: "ok1", buildstamp: "nope" },
      { instanceId: noCredId, name: "ok1", buildstamp: BS },
      { name: "ok1" },
    ]
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(400)
    expect((await post({ instanceId: "missing", name: "ok1" })).status).toBeGreaterThanOrEqual(400)
    expect(await prisma.midServer.count()).toBe(0)
  })

  it("400 buildstamp_unknown when neither body nor instance has one", async () => {
    const { encryptSecret } = await import("@/lib/vault")
    const i = await prisma.instance.create({ data: { url: "https://nobs.service-now.com/", label: "n", createdBy: "t", midUser: "m", midPasswordEnc: encryptSecret("p") } })
    const res = await post({ instanceId: i.id, name: "nb" })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("buildstamp_unknown")
  })
})

describe("DELETE /api/mids/[name]", () => {
  const mk = (name: string, state: string) => prisma.midServer.create({ data: { name, dir: "/x", serviceName: "s", state, createdBy: "t" } })

  it("member 403", async () => {
    await mk("d1", "installed")
    expect((await del("d1", { confirmName: "d1" })).status).toBe(403)
  })

  it("admin: wrong confirmName 400; ok 202 sets uninstalling with midId; busy states conflict", async () => {
    role = "admin"
    const row = await mk("d1", "installed")
    expect((await del("d1", { confirmName: "x" })).status).toBe(400)
    expect((await del("d1", {})).status).toBe(400)
    const res = await del("d1", { confirmName: "d1" })
    expect(res.status).toBe(202)
    const { jobId } = await res.json()
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "d1" } })).state).toBe("uninstalling")
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).midId).toBe(row.id)
    expect((await del("d1", { confirmName: "d1" })).status).toBe(409)
    await mk("d2", "installing")
    expect((await del("d2", { confirmName: "d2" })).status).toBe(409)
    expect((await del("nope", { confirmName: "nope" })).status).toBe(404)
  })

  it("restores the previous state when createJob fails", async () => {
    role = "admin"
    await mk("d3", "error")
    await prisma.job.create({ data: { id: "j3", midName: "d3", kind: "install", stage: "park", status: "failed", params: "{}", journalPath: "x", createdBy: "t" } })
    await prisma.job.update({ where: { id: "j3" }, data: { status: "running" } })
    expect((await del("d3", { confirmName: "d3" })).status).toBe(409)
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "d3" } })).state).toBe("error")
  })
})

it("GET /api/mids lists an installing MID with its latest job", async () => {
  const { jobId } = await (await post({ instanceId, name: "ls1" })).json()
  const { GET } = await import("./route")
  const list = (await (await GET()).json()) as { name: string; state: string; job: { id: string; kind: string } | null }[]
  const m = list.find((x) => x.name === "ls1")
  expect(m).toMatchObject({ state: "installing", job: { id: jobId, kind: "install" } })
})

it("GET /api/mids/name-check", async () => {
  await prisma.midServer.create({ data: { name: "taken", dir: "/x", serviceName: "s", state: "installed", createdBy: "t" } })
  await prisma.midServer.create({ data: { name: "was", dir: "/x", serviceName: "s", state: "removed", createdBy: "t" } })
  const { GET } = await import("./name-check/route")
  const chk = async (n: string) => (await GET(req("GET", undefined, `http://x/api/mids/name-check?name=${n}`))).json()
  expect(await chk("BAD")).toMatchObject({ valid: false, available: false })
  expect(await chk("taken")).toMatchObject({ valid: true, available: false })
  expect(await chk("was")).toEqual({ valid: true, available: true })
  expect(await chk("fresh")).toEqual({ valid: true, available: true })
})

it("GET /api/jobs/[id]: stages, no secrets; 404 unknown", async () => {
  const { jobId } = await (await post({ instanceId, name: "g1", proxy: { host: "p", port: 1, password: PROXY_PW } })).json()
  const { GET } = await import("../jobs/[id]/route")
  const res = await GET(req("GET"), { params: Promise.resolve({ id: jobId }) })
  const text = await res.text()
  const j = JSON.parse(text)
  expect(j).toMatchObject({ id: jobId, kind: "install", midName: "g1", stages: ["park"], params: { buildstamp: BS, snName: "midhub-g1" } })
  expect(text).not.toMatch(/passwordEnc|proxy|secret/)
  expect((await GET(req("GET"), { params: Promise.resolve({ id: "zzz" }) })).status).toBe(404)
})

it("POST /api/jobs/[id]/retry and cancel call the engine and audit", async () => {
  const { jobId } = await (await post({ instanceId, name: "rc1" })).json()
  await new Promise((r) => setTimeout(r, 50))
  eng.__abortForTests() // parked stage rejects -> job failed
  await eng.__idleForTests()
  expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("failed")
  eng.__resetForTests()
  const park = { name: "park", run: (ctx: { signal: AbortSignal }) => new Promise<void>((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))) }
  for (const k of ["install", "clone", "uninstall", "cancel_install"] as const) eng.registerKind(k, [park])
  const retry = await import("../jobs/[id]/retry/route")
  const r = await retry.POST(req("POST"), { params: Promise.resolve({ id: jobId }) })
  expect(r.status).toBe(202)
  expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).attempt).toBe(1)
  const cancel = await import("../jobs/[id]/cancel/route")
  expect((await cancel.POST(req("POST"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404)
  const actions = (await prisma.auditLog.findMany()).map((a) => a.action)
  expect(actions).toContain("job.retry")
})
