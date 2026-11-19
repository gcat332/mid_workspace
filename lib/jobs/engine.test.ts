import { it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-jobs-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = join(dir, "root")
process.env.JWT_SECRET = "x".repeat(40)
process.env.MIDHUB_VAULT_KEY = "k"

type Eng = typeof import("./engine")
type Jn = typeof import("./journal")
let eng: Eng
let jn: Jn
let prisma: typeof import("@/lib/db/client").prisma

const admin = { userId: "admin1", email: "a@x.com", role: "admin" as const, ahAt: 0 }
const alice = { userId: "u-alice", email: "alice@x.com", role: "member" as const, ahAt: 0 }
const bob = { userId: "u-bob", email: "bob@x.com", role: "member" as const, ahAt: 0 }

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

describe("foreign MidError copy", () => {
  it("keeps code and detail of a branded error from another chunk's class", async () => {
    eng.registerKind("install", [
      {
        name: "a",
        async run() {
          const foreign = Object.assign(new Error("ไฟล์ MID ไม่ถูกต้อง"), { code: "zip_invalid", status: 400, detail: "listing mismatch" })
          Object.defineProperty(foreign, Symbol.for("midhub.MidError"), { value: true })
          throw foreign
        },
      },
    ])
    const job = await eng.createJob(alice, "install", "mid-one", {})
    await eng.__idleForTests()
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(row.status).toBe("failed")
    expect(row.error).toBe("ไฟล์ MID ไม่ถูกต้อง")
    const err = (await journal(job.id)).find((e) => e.type === "error")
    expect(err).toMatchObject({ code: "zip_invalid", detail: "listing mismatch" })
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

const tick = () => new Promise<void>((r) => setImmediate(r))
// Bounded by wall-clock (setImmediate is never faked), not by an iteration count, so load can't starve it.
async function until(cond: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await tick()
  }
  throw new Error("until: condition not met")
}
// stage whose run() signals once it has started; the engine registers timeout/heartbeat timers BEFORE calling run(),
// so awaiting `started` is a deterministic point after which advancing fake timers is safe.
const gatedStage = (name: string, g: { promise: Promise<void> }, started: { resolve: () => void }, timeoutMs?: number) => ({
  name,
  timeoutMs,
  run: async () => {
    started.resolve()
    await g.promise
  },
})

describe("review fixes", () => {
  it("never schedules the same job twice (resume racing create, duplicate resume)", async () => {
    const gates = [deferred(), deferred(), deferred()]
    let started = 0
    eng.registerKind("install", [{ name: "a", run: async () => { await gates[started++].promise } }])
    const [j] = await Promise.all([eng.createJob(alice, "install", "m-a", {}), eng.resumeJobs()])
    await until(async () => started >= 1)
    expect(await eng.resumeJobs()).toBe(0) // already running
    await tick()
    expect(started).toBe(1)
    // queued duplicate: fill both slots, third queued, resume must not re-queue it
    await eng.createJob(alice, "install", "m-b", {})
    const third = await eng.createJob(alice, "install", "m-c", {})
    await until(async () => started === 2)
    expect(await eng.resumeJobs()).toBe(0)
    gates.forEach((g) => g.resolve())
    await eng.__idleForTests()
    expect(started).toBe(3)
    expect((await prisma.job.findUniqueOrThrow({ where: { id: third.id } })).status).toBe("succeeded")
    expect(j.id).toBeTruthy()
  })

  async function blockJournal(id: string) {
    const fs = await import("node:fs")
    fs.rmSync(jn.journalPath(id), { force: true })
    fs.mkdirSync(jn.journalPath(id)) // appendFile now fails with EISDIR
  }

  it("journal failure during retry does not strand the job", async () => {
    simpleKind("install", { name: "b", times: 1 })
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    await blockJournal(job.id)
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await eng.retryJob(alice, job.id)
    await eng.__idleForTests()
    err.mockRestore()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
  })

  it("journal failure during cancel_install creation does not strand the new job", async () => {
    simpleKind("install", { name: "a", times: 5 })
    simpleKind("cancel_install")
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    await blockJournal(job.id)
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const c = await eng.cancelJob(alice, job.id)
    await eng.__idleForTests()
    err.mockRestore()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("succeeded")
  })

  it("retry authorisation: member only own install/clone; admin any", async () => {
    simpleKind("install", { name: "a", times: 1 })
    simpleKind("uninstall", { name: "a", times: 1 })
    const own = await eng.createJob(alice, "install", "m-a", {})
    const un = await eng.createJob(alice, "uninstall", "m-b", {})
    await eng.__idleForTests()
    await expect(eng.retryJob(bob, own.id)).rejects.toMatchObject({ code: "forbidden" })
    await expect(eng.retryJob(alice, un.id)).rejects.toMatchObject({ code: "forbidden" })
    await expect(eng.retryJob(alice, own.id)).resolves.toBeTruthy()
    await expect(eng.retryJob(admin, un.id)).resolves.toBeTruthy()
    await eng.__idleForTests()
  })

  it("cancel landing between read and stage write: no stage runs, job stays cancelled", async () => {
    simpleKind("install")
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    await prisma.job.update({ where: { id: job.id }, data: { status: "queued", stage: "a" } })
    calls = []
    const orig = prisma.job.findUnique.bind(prisma.job)
    const spy = vi.spyOn(prisma.job, "findUnique").mockImplementationOnce(((args: never) => {
      const r = orig(args)
      return r.then(async (row) => {
        await prisma.job.update({ where: { id: job.id }, data: { status: "cancelled" } })
        return row
      })
    }) as never)
    expect(await eng.resumeJobs()).toBe(1)
    await eng.__idleForTests()
    spy.mockRestore()
    expect(calls).toEqual([])
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled")
  })

  it("corrupt params and unknown recorded stage fail visibly", async () => {
    simpleKind("install")
    const j1 = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    await prisma.job.update({ where: { id: j1.id }, data: { status: "queued", stage: "a", params: "{oops" } })
    const j2 = await eng.createJob(alice, "install", "m-b", {})
    await eng.__idleForTests()
    await prisma.job.update({ where: { id: j2.id }, data: { status: "queued", stage: "zzz" } })
    calls = []
    await eng.resumeJobs()
    await eng.__idleForTests()
    const r1 = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } })
    const r2 = await prisma.job.findUniqueOrThrow({ where: { id: j2.id } })
    expect([r1.status, r2.status]).toEqual(["failed", "failed"])
    expect(calls).toEqual([])
    expect(((await journal(j1.id)).find((e) => e.type === "error") as JE).detail).toContain("params ไม่ถูกต้อง")
    expect(r2.stage).toBe("zzz")
  })

  it("redacts secrets in error detail and caps at 500 chars", async () => {
    eng.registerKind("install", [{ name: "a", run: async () => { throw new Error("fail password=hunter2 Authorization: Basic dXNlcjpwYXNz " + "x".repeat(900)) } }])
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    const d = ((await journal(job.id)).find((e) => e.type === "error") as JE).detail as string
    expect(d).not.toContain("hunter2")
    expect(d).not.toContain("dXNlcjpwYXNz")
    expect(d.length).toBeLessThanOrEqual(500)
  })

  describe("stage timeout (fake timers)", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }))
    afterEach(() => vi.useRealTimers())

    it("aborts at timeoutMs, hard-fails 60s later, frees the slot, ignores late settlement", async () => {
      const g = deferred()
      let sig: AbortSignal | undefined
      eng.registerKind("install", [{ name: "a", timeoutMs: 1000, run: async (ctx) => { sig = ctx.signal; await g.promise } }])
      const job = await eng.createJob(alice, "install", "m-a", {})
      await until(async () => !!sig)
      expect(sig!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(sig!.aborted).toBe(true)
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("running")
      await vi.advanceTimersByTimeAsync(60_000)
      await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "failed")
      const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(row.error).toContain("ขั้นตอน a ใช้เวลานานเกินกำหนด")
      await until(async () => (await journal(job.id)).some((e) => e.type === "error"))
      const j = await journal(job.id)
      expect(j.find((e) => e.type === "error")!.code).toBe("stage_timeout")
      expect(j.some((e) => e.level === "warn")).toBe(true)
      g.resolve() // late settlement must not revive it
      await tick()
      await eng.__idleForTests()
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed")
    })

    it("heartbeat bumps updatedAt every 30s while a stage runs", async () => {
      const g = deferred()
      const started = deferred()
      eng.registerKind("install", [gatedStage("a", g, started)])
      const job = await eng.createJob(alice, "install", "m-a", {})
      await started.promise
      const before = (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).updatedAt.getTime()
      await vi.advanceTimersByTimeAsync(30_000)
      await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).updatedAt.getTime() > before)
      g.resolve()
      await eng.__idleForTests()
    })
  })

  it("retry/cancel during the failure end window (onFailure running) -> job_running; works afterwards", async () => {
    const gate = deferred()
    eng.registerKind("install", [{ name: "a", run: async () => { if (calls.length === 0) { calls.push("a"); throw new Error("x") } calls.push("a2") } }], {
      onFailure: () => gate.promise,
    })
    eng.registerKind("cancel_install", [{ name: "c", run: async () => { calls.push("cancel") } }])
    const job = await eng.createJob(alice, "install", "m-a", {})
    await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "failed")
    // Retry gets its own text (the shared job_running text says "cannot cancel", which is wrong for a retry).
    await expect(eng.retryJob(alice, job.id)).rejects.toMatchObject({ code: "job_running", status: 409, message: "งานยังปิดตัวไม่เสร็จ รอสักครู่แล้วกด ลองใหม่" })
    await expect(eng.cancelJob(alice, job.id)).rejects.toMatchObject({ code: "job_running", status: 409, message: "งานกำลังทำงานอยู่ ยกเลิกไม่ได้ในตอนนี้" })
    gate.resolve()
    await eng.__idleForTests()
    await eng.retryJob(alice, job.id)
    await eng.__idleForTests()
    expect(calls).toEqual(["a", "a2"])
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
  })

  it("a stage that throws synchronously fails the job and leaks nothing", async () => {
    const unhandled: unknown[] = []
    const h = (e: unknown) => unhandled.push(e)
    process.on("unhandledRejection", h)
    eng.registerKind("install", [{ name: "a", run: (() => { throw new Error("sync boom") }) as () => Promise<void> }])
    const job = await eng.createJob(alice, "install", "m-a", {})
    await eng.__idleForTests()
    for (let i = 0; i < 20; i++) await tick()
    process.off("unhandledRejection", h)
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(row.status).toBe("failed")
    expect(unhandled).toEqual([])
  })

  describe("hooks timeout and zombie guard (fake timers)", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }))
    afterEach(() => vi.useRealTimers())

    it("a hung onFailure hook is aborted, logged CRITICAL, slot freed, status unchanged", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
      let sig: AbortSignal | undefined
      eng.registerKind("install", [{ name: "a", run: async () => { throw new Error("x") } }], {
        onFailure: (ctx) => { sig = ctx.signal; return new Promise<void>(() => undefined) },
      })
      const job = await eng.createJob(alice, "install", "m-a", {})
      await until(async () => !!sig)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(sig!.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      await eng.__idleForTests()
      expect(err.mock.calls.some((c) => String(c[0]).includes("CRITICAL"))).toBe(true)
      err.mockRestore()
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed")
    })

    it("zombie stage blocks createJob/retryJob/cancelJob for the MID until it settles", async () => {
      const g = deferred()
      const started = deferred()
      eng.registerKind("install", [gatedStage("a", g, started, 1000)])
      eng.registerKind("cancel_install", [{ name: "c", run: async () => undefined }])
      const job = await eng.createJob(alice, "install", "m-a", {})
      await started.promise
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(60_000)
      await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "failed")
      await eng.__idleForTests()
      const blocked = { code: "job_active", detail: "ขั้นตอนเดิมยังไม่หยุดสนิท รอสักครู่" }
      await expect(eng.createJob(alice, "install", "m-a", {})).rejects.toMatchObject(blocked)
      await expect(eng.retryJob(alice, job.id)).rejects.toMatchObject(blocked)
      await expect(eng.cancelJob(alice, job.id)).rejects.toMatchObject(blocked)
      await expect(eng.createJob(alice, "install", "m-other", {})).resolves.toBeTruthy()
      g.resolve() // zombie settles -> guard lifted
      for (let i = 0; i < 20; i++) await tick()
      await eng.__idleForTests()
      await expect(eng.createJob(alice, "install", "m-a", {})).resolves.toBeTruthy()
    })

    it("zombie guard expires after 10 minutes", async () => {
      const g = deferred()
      const started = deferred()
      eng.registerKind("install", [gatedStage("a", g, started, 1000)])
      const job = await eng.createJob(alice, "install", "m-a", {})
      await started.promise
      await vi.advanceTimersByTimeAsync(61_000)
      await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "failed")
      await eng.__idleForTests()
      await expect(eng.retryJob(alice, job.id)).rejects.toMatchObject({ code: "job_active" })
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await expect(eng.retryJob(alice, job.id)).resolves.toBeTruthy()
      g.resolve()
      await eng.__idleForTests()
    })
  })
})
