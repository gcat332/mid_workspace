import { it, expect, vi, beforeAll, afterAll, beforeEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-jobs-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = join(dir, "root")
process.env.JWT_SECRET = "x".repeat(40)
process.env.ADMIN_EMAIL = "a@x.com"
process.env.ADMIN_PASSWORD = "pw"
process.env.MIDHUB_VAULT_KEY = "k"

type Eng = typeof import("./engine")
type Jn = typeof import("./journal")
let eng: Eng
let jn: Jn
let prisma: typeof import("@/lib/db/client").prisma

const admin = { userId: "admin1", email: "a@x.com", role: "admin" as const }
const alice = { userId: "u-alice", email: "alice@x.com", role: "member" as const }
const bob = { userId: "u-bob", email: "bob@x.com", role: "member" as const }

type JE = { t: string; type: string; stage?: string; code?: string; detail?: string; level?: string; msg?: string; password?: string; nested?: unknown }
const journal = async (id: string) => (await jn.readJournal(id)) as JE[]

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

let calls: string[] = []
const stageOf = async (id: string) => (await prisma.job.findUniqueOrThrow({ where: { id } })).stage

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
  eng = await import("./engine")
  jn = await import("./journal")
}, 60000)

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await eng.__idleForTests()
  eng.__resetForTests()
  calls = []
  await prisma.job.deleteMany()
})

function simpleKind(kind: "install" | "clone" | "uninstall" | "cancel_install", failAt?: { name: string; times: number }) {
  let left = failAt?.times ?? 0
  const mk = (name: string) => ({
    name,
    async run() {
      calls.push(name)
      if (failAt?.name === name && left-- > 0) throw new Error("boom")
    },
  })
  eng.registerKind(kind, [mk("a"), mk("b"), mk("c")])
}

describe("engine", () => {
  it("runs stages in order, writing stage to DB before each run", async () => {
    const seen: string[] = []
    const mk = (name: string) => ({
      name,
      async run(ctx: { job: { id: string } }) {
        seen.push(`${name}:${await stageOf(ctx.job.id)}`)
      },
    })
    eng.registerKind("install", [mk("a"), mk("b"), mk("c")])
    const job = await eng.createJob(alice, "install", "mid-one", { x: 1 })
    expect(job.status).toBe("queued")
    expect(job.stage).toBe("a")
    await eng.__idleForTests()
    expect(seen).toEqual(["a:a", "b:b", "c:c"])
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(done.status).toBe("succeeded")
    expect(done.finishedAt).not.toBeNull()
    const j = await journal(job.id)
    expect(j.filter((e) => e.type === "stage").map((e) => e.stage)).toEqual(["a", "b", "c"])
    expect(statSync(jn.journalPath(job.id)).mode & 0o777).toBe(0o640)
    expect(statSync(process.env.MIDHUB_ROOT + "/jobs").mode & 0o777).toBe(0o750)
  })

  it("a throwing stage fails the job at that stage with Thai message and journal error", async () => {
    simpleKind("install", { name: "b", times: 1 })
    const job = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(row.status).toBe("failed")
    expect(row.stage).toBe("b")
    expect(row.error).toContain("ตัวช่วยระบบทำงานผิดพลาด")
    expect(calls).toEqual(["a", "b"])
    const err = (await journal(job.id)).find((e) => e.type === "error")!
    expect(err.code).toBe("internal")
    expect(err.detail).toContain("boom")
  })

  it("MidError message/code is preserved", async () => {
    const { MidError } = await import("@/lib/mids/names")
    eng.registerKind("install", [{ name: "a", run: async () => { throw new MidError("disk_full") } }])
    const job = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(row.error).toContain("พื้นที่ของ MID เต็ม")
    expect((await journal(job.id)).find((e) => e.type === "error")!.code).toBe("disk_full")
  })

  it("retryJob resumes at the failed stage and bumps attempt", async () => {
    simpleKind("install", { name: "b", times: 1 })
    const job = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    calls = []
    const r = await eng.retryJob(alice, job.id)
    expect(r.status).toBe("queued")
    expect(r.attempt).toBe(1)
    await eng.__idleForTests()
    expect(calls).toEqual(["b", "c"])
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
  })

  it("retryJob rejects non-failed jobs and unknown ids", async () => {
    simpleKind("install")
    const job = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    await expect(eng.retryJob(alice, job.id)).rejects.toMatchObject({ code: "conflict" })
    await expect(eng.retryJob(alice, "nope")).rejects.toMatchObject({ code: "job_not_found", status: 404 })
  })

  it("crash resume: running job at stage 2 with a fresh engine runs stages 2..n only", async () => {
    simpleKind("install")
    const job = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    await prisma.job.update({ where: { id: job.id }, data: { status: "running", stage: "b", finishedAt: null } })
    calls = []
    eng.__resetForTests()
    simpleKind("install")
    expect(await eng.resumeJobs()).toBe(1)
    await eng.__idleForTests()
    expect(calls).toEqual(["b", "c"])
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
  })

  it("resumeJobs also picks up queued jobs", async () => {
    simpleKind("install")
    const job = await eng.createJob(alice, "install", "mid-q", {})
    await eng.__idleForTests()
    await prisma.job.update({ where: { id: job.id }, data: { status: "queued", stage: "a" } })
    eng.__resetForTests()
    simpleKind("install")
    expect(await eng.resumeJobs()).toBe(1)
    await eng.__idleForTests()
    expect(calls.slice(-3)).toEqual(["a", "b", "c"])
  })

  it("two concurrent createJob for the same MID: exactly one wins", async () => {
    const gate = deferred()
    eng.registerKind("install", [{ name: "a", run: () => gate.promise }])
    const res2 = await Promise.allSettled([
      eng.createJob(alice, "install", "mid-two", {}),
      eng.createJob(bob, "install", "mid-two", {}),
      eng.createJob(admin, "install", "mid-two", {}),
    ])
    expect(res2.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = res2.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(rejected.map((r) => r.reason.code)).toEqual(["job_active", "job_active"])
    expect(await prisma.job.count({ where: { midName: "mid-two" } })).toBe(1)
    gate.resolve()
    await eng.__idleForTests()
  })

  it("different MIDs are not blocked; failed job does not block a new job", async () => {
    simpleKind("install", { name: "a", times: 1 })
    const j1 = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: j1.id } })).status).toBe("failed")
    await expect(eng.createJob(alice, "install", "mid-one", {})).resolves.toBeTruthy()
  })

  it("max 2 concurrent; third waits", async () => {
    const gates = [deferred(), deferred(), deferred()]
    let started = 0
    eng.registerKind("install", [
      { name: "a", run: async () => { const g = gates[started++]; await g.promise } },
    ])
    const j = await Promise.all(["m-a", "m-b", "m-c"].map((n) => eng.createJob(alice, "install", n, {})))
    await vi.waitFor(() => expect(started).toBe(2))
    await new Promise((r) => setTimeout(r, 50))
    expect(started).toBe(2)
    expect((await prisma.job.findUniqueOrThrow({ where: { id: j[2].id } })).status).toBe("queued")
    gates[0].resolve()
    await vi.waitFor(() => expect(started).toBe(3))
    gates[1].resolve()
    gates[2].resolve()
    await eng.__idleForTests()
    expect(await prisma.job.count({ where: { status: "succeeded" } })).toBe(3)
  })

  it("hooks: onSuccess and onFailure run", async () => {
    const hits: string[] = []
    eng.registerKind("install", [{ name: "a", run: async () => { if (calls.length) throw new Error("x"); calls.push("a") } }], {
      onSuccess: async () => { hits.push("ok") },
      onFailure: async (_c, e) => { hits.push("fail:" + (e as Error).message) },
    })
    await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    await eng.createJob(alice, "install", "m-b", {})
    await eng.__idleForTests()
    expect(hits).toEqual(["ok", "fail:x"])
  })

  it("rejects password-like params unless suffixed Enc; accepts passwordEnc", async () => {
    simpleKind("install")
    await expect(eng.createJob(alice, "install", "m-a", { password: "x" })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(eng.createJob(alice, "install", "m-a", { a: { midPassword: "x" } })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(eng.createJob(alice, "install", "m-a", { passwordEnc: "v1:abc" })).resolves.toBeTruthy()
  })

  it("rejects unregistered kind and invalid name", async () => {
    await expect(eng.createJob(alice, "install", "m-a", {})).rejects.toMatchObject({ code: "internal" })
    simpleKind("install")
    await expect(eng.createJob(alice, "install", "BAD NAME", {})).rejects.toMatchObject({ code: "invalid_name" })
  })

  it("journal strips password fields and tolerates torn lines", async () => {
    await jn.appendJournal("jx", { type: "x", password: "p", nested: { dbPassword: "q", ok: 1 } })
    const fs = await import("node:fs")
    fs.appendFileSync(jn.journalPath("jx"), '{"torn":')
    const j = await journal("jx")
    expect(j).toHaveLength(1)
    expect(j[0].password).toBeUndefined()
    expect(j[0].nested).toEqual({ ok: 1 })
    expect(typeof j[0].t).toBe("string")
    expect(await jn.readJournal("missing")).toEqual([])
  })

  it("ctx.log writes journal entries", async () => {
    eng.registerKind("install", [{ name: "a", run: async (ctx) => { await ctx.log("hello", "warn") } }])
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    expect((await journal(job.id)).some((e) => e.type === "log" && e.level === "warn" && e.msg === "hello")).toBe(true)
  })

  it("runner state lives on globalThis under a symbol key", () => {
    const key = Symbol.for("midhub.jobEngine")
    const g = globalThis as unknown as Record<symbol, unknown>
    simpleKind("install")
    expect(g[key]).toBeTruthy()
    eng.__resetForTests()
    expect(g[key]).toBeUndefined()
  })
})

describe("cancelJob", () => {
  it("member cannot cancel another user's failed job (403); admin can", async () => {
    simpleKind("install", { name: "a", times: 5 })
    simpleKind("cancel_install")
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    await expect(eng.cancelJob(bob, job.id)).rejects.toMatchObject({ code: "forbidden", status: 403 })
    const c = await eng.cancelJob(admin, job.id)
    expect(c.kind).toBe("cancel_install")
    expect(c.midName).toBe("m-a")
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled")
    await eng.__idleForTests()
  })

  it("member can cancel their own failed install -> cancel_install job", async () => {
    simpleKind("clone", { name: "a", times: 5 })
    simpleKind("cancel_install")
    const job = await eng.createJob(alice, "clone", "m-a", {})
    await eng.__idleForTests()
    calls = []
    const c = await eng.cancelJob(alice, job.id)
    expect(c.createdBy).toBe(alice.userId)
    expect(JSON.parse(c.params)).toMatchObject({ cancelOf: job.id })
    await eng.__idleForTests()
    expect(calls).toEqual(["a", "b", "c"])
  })

  it("cancel_install kind unregistered -> internal with detail, job untouched", async () => {
    simpleKind("install", { name: "a", times: 5 })
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    const err = await eng.cancelJob(alice, job.id).catch((e) => e)
    expect(err.code).toBe("internal")
    expect(err.detail).toContain("cancel_install")
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed")
  })

  it("queued -> cancelled directly (admin only); member forbidden", async () => {
    const gate = deferred()
    eng.registerKind("install", [{ name: "a", run: () => gate.promise }])
    await Promise.all(["m-1", "m-2"].map((n) => eng.createJob(alice, "install", n, {})))
    const q = await eng.createJob(alice, "install", "m-3", {})
    expect(q.status).toBe("queued")
    await expect(eng.cancelJob(alice, q.id)).rejects.toMatchObject({ code: "forbidden" })
    const c = await eng.cancelJob(admin, q.id)
    expect(c.status).toBe("cancelled")
    gate.resolve()
    await eng.__idleForTests()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("cancelled")
  })

  it("running -> 409 job_running; unknown -> 404; succeeded -> conflict", async () => {
    const gate = deferred()
    eng.registerKind("install", [{ name: "a", run: () => gate.promise }])
    const job = await eng.createJob(alice, "install", "m-a", {})
    await vi.waitFor(async () => expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("running"))
    await expect(eng.cancelJob(admin, job.id)).rejects.toMatchObject({ code: "job_running", status: 409 })
    await expect(eng.cancelJob(admin, "nope")).rejects.toMatchObject({ code: "job_not_found" })
    gate.resolve()
    await eng.__idleForTests()
    await expect(eng.cancelJob(admin, job.id)).rejects.toMatchObject({ code: "conflict" })
  })
})
