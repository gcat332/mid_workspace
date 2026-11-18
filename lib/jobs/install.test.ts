import { it, expect, beforeAll, afterAll, beforeEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-install-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = join(dir, "root")
process.env.JWT_SECRET = "x".repeat(40)
process.env.ADMIN_EMAIL = "a@x.com"
process.env.ADMIN_PASSWORD = "pw"
process.env.MIDHUB_VAULT_KEY = Buffer.alloc(32, 7).toString("base64")

const BS = "australia-02-11-2026__patch7-11-10-2026_11-12-2026_0100"
const INST_PW = "inst-secret-PW-123"
const PROXY_PW = "proxy-secret-PW-456"
const admin = { userId: "admin1", email: "a@x.com", role: "admin" as const }

let eng: typeof import("./engine")
let inst: typeof import("./install")
let prisma: typeof import("@/lib/db/client").prisma
let calls: string[] = []
let configured: unknown[] = []
let failStart = 0
let failStartAfter = 0
let sinces: Date[] = []
let connectFail: Error | null = null
let freeBytes: number | null = 10 * 1024 ** 3
let instanceId = ""

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
  eng = await import("./engine")
  inst = await import("./install")
  const { MidError } = await import("@/lib/mids/names")
  const { encryptSecret } = await import("@/lib/vault")
  const i = await prisma.instance.create({
    data: { label: "dev", url: "https://dev1.service-now.com", midUser: "midu", midPasswordEnc: encryptSecret(INST_PW), createdBy: "admin1" },
  })
  instanceId = i.id
  Object.assign(inst.deps, {
    diskStatus: async () => ({ freeBytes, totalBytes: null, usage: null }),
    ensurePackage: async (b: string, o: { onProgress?: (d: number, t: number | null) => void }) => {
      calls.push("ensurePackage")
      for (let k = 0; k <= 100; k++) o.onProgress?.(k, 100)
      return `/pkg/${b}`
    },
    extractPackage: async () => void calls.push("extract"),
    cloneFiles: async (src: string, dst: string) => {
      calls.push(`clone:${src}->${dst}`)
      return { skipped: ["a.jar"], warnings: ["clone warn"] }
    },
    configureMid: async (n: string, input: Record<string, unknown>) => {
      calls.push("configure")
      configured.push(input)
      return { warnings: ["cfg warn"] }
    },
    callHelper: async (req: { op: string; heapMb?: number }) => {
      calls.push(req.op + (req.heapMb ? `(${req.heapMb})` : ""))
      if (req.op === "start" && failStart-- > 0) throw new MidError("quota_full")
      if (req.op === "start" && failStartAfter-- > 0) throw new Error("helper reply lost")
      return { ok: true as const }
    },
    waitConnected: async (_n: string, since: Date) => {
      calls.push("waitConnected")
      sinces.push(since)
      if (connectFail) throw connectFail
    },
    gcPackages: async () => (calls.push("gc"), []),
  })
}, 60000)

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await eng.__idleForTests()
  eng.__resetForTests()
  inst.registerInstallKinds()
  inst.registerInstallKinds()
  calls = []
  configured = []
  failStart = 0
  failStartAfter = 0
  sinces = []
  connectFail = null
  freeBytes = 10 * 1024 ** 3
  await prisma.job.deleteMany()
  await prisma.midServer.deleteMany()
})

async function mkMid(name: string, state = "installing") {
  await prisma.midServer.create({ data: { name, instanceId, dir: `/x/${name}`, serviceName: `midhub-mid-${name}.service`, state, createdBy: "admin1" } })
}
const params = (extra: object = {}) => ({
  instanceId, buildstamp: BS, snName: "sn-mid", heapMb: 768, logFiles: 3,
  proxy: { host: "px", port: 3128, user: "pu", passwordEnc: "" as string }, ...extra,
})
async function withProxy(extra: object = {}) {
  const { encryptSecret } = await import("@/lib/vault")
  const p = params(extra)
  p.proxy.passwordEnc = encryptSecret(PROXY_PW)
  return p
}
const run = async (kind: "install" | "clone", name: string, p: object) => {
  const j = await eng.createJob(admin, kind, name, p)
  await eng.__idleForTests()
  return prisma.job.findUniqueOrThrow({ where: { id: j.id } })
}

describe("install kinds", () => {
  it("happy path: helper ops in order, MidServer installed, secrets never persisted", async () => {
    await mkMid("m1")
    const job = await run("install", "m1", await withProxy())
    expect(job.status).toBe("succeeded")
    expect(calls).toEqual(["ensurePackage", "extract", "configure", "fixOwnership", "installUnit(768)", "start", "waitConnected", "gc"])
    expect(configured[0]).toMatchObject({ url: "https://dev1.service-now.com/", password: INST_PW, snName: "sn-mid", proxy: { host: "px", port: 3128, user: "pu", password: PROXY_PW } })
    const mid = await prisma.midServer.findUniqueOrThrow({ where: { name: "m1" } })
    expect(mid).toMatchObject({ state: "installed", version: BS })
    const jr = readFileSync(job.journalPath, "utf8")
    expect(jr).toContain("cfg warn")
    // Audit rows are written by the Task 9 routes (their tests cover audit); the job engine writes none.
    for (const s of [INST_PW, PROXY_PW]) {
      for (const hay of [jr, JSON.stringify(job)]) expect(hay).not.toContain(s)
    }
    expect(sinces[0].toISOString()).toBe(JSON.parse(job.params).startedAt)
    expect(JSON.parse(job.params).startedAt).toBeTruthy()
  })

  it("clone path runs cloneFiles before configure and journals skipped/warnings", async () => {
    await mkMid("src", "installed")
    await mkMid("m2")
    const job = await run("clone", "m2", await withProxy({ cloneFrom: "src" }))
    expect(job.status).toBe("succeeded")
    expect(calls.indexOf("extract")).toBeLessThan(calls.indexOf("clone:src->m2"))
    expect(calls.indexOf("clone:src->m2")).toBeLessThan(calls.indexOf("configure"))
    const jr = readFileSync(job.journalPath, "utf8")
    expect(jr).toContain("a.jar")
    expect(jr).toContain("clone warn")
  })

  it("journals download progress at most once per 5%", async () => {
    await mkMid("m3")
    const job = await run("install", "m3", params({ proxy: undefined }))
    const n = (readFileSync(job.journalPath, "utf8").match(/ดาวน์โหลด package/g) ?? []).length
    expect(n).toBeGreaterThan(1)
    expect(n).toBeLessThanOrEqual(21)
  })

  it("quota_full at start fails the job at start; retry resumes without re-download/extract", async () => {
    await mkMid("m4")
    failStart = 1
    const job = await run("install", "m4", params({ proxy: undefined }))
    expect(job).toMatchObject({ status: "failed", stage: "start" })
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m4" } })).state).toBe("error")
    const first = JSON.parse(job.params).startedAt as string
    calls = []
    await new Promise((r) => setTimeout(r, 5))
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("succeeded")
    expect(calls).toEqual(["restart", "waitConnected", "gc"])
    expect(JSON.parse(after.params).startedAt > first).toBe(true)
    expect(sinces[0].toISOString()).toBe(JSON.parse(after.params).startedAt)
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m4" } })).state).toBe("installed")
  })

  it("disk_low at precheck fails before any download", async () => {
    await mkMid("m5")
    freeBytes = 1024
    const job = await run("install", "m5", params({ proxy: undefined }))
    expect(job).toMatchObject({ status: "failed", stage: "precheck" })
    expect(calls).toEqual([])
    expect(existsSync(job.journalPath)).toBe(true)
    expect(readFileSync(job.journalPath, "utf8")).toContain("disk_low")
  })

  it("precheck rejects a removed clone source", async () => {
    await mkMid("src2", "removed")
    await mkMid("m6")
    const job = await run("clone", "m6", params({ proxy: undefined, cloneFrom: "src2" }))
    expect(job).toMatchObject({ status: "failed", stage: "precheck" })
    expect(calls).toEqual([])
  })

  it("retry of start after the helper already started uses restart and a new since", async () => {
    await mkMid("m7")
    failStartAfter = 1
    const job = await run("install", "m7", params({ proxy: undefined }))
    expect(job).toMatchObject({ status: "failed", stage: "start" })
    const first = JSON.parse(job.params).startedAt as string
    expect(calls.at(-1)).toBe("start")
    await new Promise((r) => setTimeout(r, 5))
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("succeeded")
    expect(calls.filter((c) => c === "start" || c === "restart")).toEqual(["start", "restart"])
    const second = JSON.parse(after.params).startedAt as string
    expect(second > first).toBe(true)
    expect(sinces).toHaveLength(1)
    expect(sinces[0].toISOString()).toBe(second)
  })

  it("connect_timeout journals the ERROR lines and keeps a short detail", async () => {
    await mkMid("m8")
    const { MidError } = await import("@/lib/mids/names")
    connectFail = new MidError("connect_timeout", undefined, undefined, "ERROR first\nSEVERE second")
    const job = await run("install", "m8", params({ proxy: undefined }))
    expect(job).toMatchObject({ status: "failed", stage: "waitConnected" })
    const entries = (await (await import("./journal")).readJournal(job.id)) as { type: string; level?: string; msg?: string; code?: string; detail?: string }[]
    expect(entries.filter((e) => e.level === "error").map((e) => e.msg)).toEqual(["ERROR first", "SEVERE second"])
    expect(entries.find((e) => e.type === "error")).toMatchObject({ code: "connect_timeout", detail: "ดูบรรทัด ERROR ใน log ของงานนี้" })
  })

  it("precheck requires an installing MidServer row and cloneFrom != midName", async () => {
    const a = await run("install", "nomid", params({ proxy: undefined }))
    expect(a).toMatchObject({ status: "failed", stage: "precheck" })
    await mkMid("m9", "installed")
    const b = await run("install", "m9", params({ proxy: undefined }))
    expect(b).toMatchObject({ status: "failed", stage: "precheck" })
    await mkMid("m10")
    const c = await run("clone", "m10", params({ proxy: undefined, cloneFrom: "m10" }))
    expect(c).toMatchObject({ status: "failed", stage: "precheck" })
    expect(c.error).toBeTruthy()
    expect(calls).toEqual([])
  })

  it("precheck refuses a job from an older lifecycle (newer job exists for the name)", async () => {
    await mkMid("m12")
    freeBytes = 1
    const j1 = await run("install", "m12", params({ proxy: undefined }))
    expect(j1).toMatchObject({ status: "failed", stage: "precheck", error: expect.stringContaining("ดิสก์") })
    await prisma.job.create({
      data: { id: "newer-j", midName: "m12", kind: "install", stage: "precheck", status: "cancelled", params: "{}", journalPath: "x", createdBy: "t", createdAt: new Date(Date.now() + 5000) },
    })
    freeBytes = 10 * 1024 ** 3
    await eng.retryJob(admin, j1.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } })
    expect(after).toMatchObject({ status: "failed", stage: "precheck", error: expect.stringContaining("ขัดแย้ง") })
    expect(calls).toEqual([])
  })

  it("logs 100% progress once", async () => {
    await mkMid("m11")
    const job = await run("install", "m11", params({ proxy: undefined }))
    expect((readFileSync(job.journalPath, "utf8").match(/package 100%/g) ?? []).length).toBe(1)
  })

  it("precheck failure (disk_low) is retryable: state error goes back to installing and ends installed", async () => {
    await mkMid("m12")
    freeBytes = 1024
    const job = await run("install", "m12", params({ proxy: undefined }))
    expect(job).toMatchObject({ status: "failed", stage: "precheck" })
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m12" } })).state).toBe("error")
    freeBytes = 10 * 1024 ** 3
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m12" } })).state).toBe("installed")
  })
})
