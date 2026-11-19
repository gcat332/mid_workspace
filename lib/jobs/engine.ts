import { randomUUID } from "node:crypto"
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import type { SessionPayload } from "@/lib/auth/jwt"
import { MidError, validateMidName } from "@/lib/mids/names"
import { appendJournal, journalPath } from "./journal"

export type JobKind = "install" | "clone" | "uninstall" | "cancel_install"
export type JobRow = Prisma.JobGetPayload<object>

export type JobCtx = {
  job: JobRow
  params: Record<string, unknown>
  log(msg: string, level?: "info" | "warn" | "error"): Promise<void>
  signal: AbortSignal
}
// Every stage must be safe to run again after a crash (idempotent).
// run MUST be idempotent and MUST honour ctx.signal (pass it to fetch/execFile/streams).
export type Stage = { name: string; run(ctx: JobCtx): Promise<void>; /** default 30 min */ timeoutMs?: number }
export type KindHooks = {
  onSuccess?(ctx: JobCtx): Promise<void>
  onFailure?(ctx: JobCtx, err: unknown): Promise<void>
}

const MAX_CONCURRENT = 2
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000
const ABORT_GRACE_MS = 60_000
const HEARTBEAT_MS = 30_000
const HOOK_TIMEOUT_MS = 5 * 60_000
const HOOK_GRACE_MS = 30_000
const ZOMBIE_TTL_MS = 10 * 60_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Best-effort journal write: a journal failure must never strand a committed job.
async function tryJournal(id: string, entry: object): Promise<void> {
  try {
    await appendJournal(id, entry)
  } catch (e) {
    console.error("[jobs] journal write failed", id, e)
  }
}

// DB write that must not be lost: retry once after 1s, then log loudly.
async function writeOnce(label: string, id: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    return
  } catch {
    await sleep(1000)
  }
  try {
    await fn()
  } catch (e) {
    console.error(`[jobs] CRITICAL: could not persist ${label} for job ${id}; job may appear stuck`, e)
  }
}

export function redact(s: string): string {
  return s
    .replace(/(pass(?:word|wd)?|pwd)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2***")
    .replace(/(authorization\s*:\s*)[^\n]*/gi, "$1***")
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{6,}/g, "$1 ***")
    .slice(0, 500)
}
const STATE_KEY = Symbol.for("midhub.jobEngine")

interface EngineState {
  kinds: Map<JobKind, { stages: Stage[]; hooks: KindHooks }>
  queue: string[]
  running: Set<string>
  inflight: Set<Promise<void>>
  locks: Map<string, Promise<unknown>>
  zombies: Map<string, ReturnType<typeof setTimeout>>
  abort: AbortController
}

// Kept on globalThis so Next dev hot reload / duplicated module instances share one runner.
function state(): EngineState {
  const g = globalThis as unknown as Record<symbol, EngineState | undefined>
  return (g[STATE_KEY] ??= {
    kinds: new Map(),
    queue: [],
    running: new Set(),
    inflight: new Set(),
    locks: new Map(),
    zombies: new Map(),
    abort: new AbortController(),
  })
}

export function registerKind(kind: JobKind, stages: Stage[], hooks: KindHooks = {}): void {
  if (!stages.length) throw new Error(`job kind ${kind} needs at least one stage`)
  state().kinds.set(kind, { stages, hooks })
}

/** Test hook: drop all runner state (simulates a fresh process). */
export function __resetForTests(): void {
  state().abort.abort()
  ;(globalThis as unknown as Record<symbol, unknown>)[STATE_KEY] = undefined
}
/** Test hook: abort the signal handed to stages. */
export function __abortForTests(): void {
  state().abort.abort()
}
/** Test hook: resolves when nothing is queued or running. */
export async function __idleForTests(): Promise<void> {
  const st = state()
  while (st.inflight.size || st.queue.length) await Promise.all([...st.inflight])
}

const SECRET_KEY = /password/i
function assertNoSecrets(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(assertNoSecrets)
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && !k.endsWith("Enc")) {
        throw new MidError("invalid_request", undefined, undefined, `params must not contain plaintext secret key "${k}"`)
      }
      assertNoSecrets(val)
    }
  }
}

function parseParams(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function withMidLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const st = state()
  const prev = st.locks.get(name) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => undefined)
  st.locks.set(name, tail)
  void tail.then(() => {
    if (st.locks.get(name) === tail) st.locks.delete(name)
  })
  return next
}

function assertNoZombie(midName: string): void {
  if (state().zombies.has(midName)) {
    throw new MidError("job_active", undefined, undefined, "ขั้นตอนเดิมยังไม่หยุดสนิท รอสักครู่")
  }
}

function kindOrThrow(kind: JobKind) {
  const k = state().kinds.get(kind)
  if (!k) throw new MidError("internal", undefined, undefined, `job kind "${kind}" is not registered`)
  return k
}

const ACTIVE = ["queued", "running"]

// Caller holds the per-MID lock. Check + insert run in one transaction.
async function insertJob(kind: JobKind, midName: string, createdBy: string, params: object, extra?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<JobRow> {
  const k = kindOrThrow(kind)
  const id = randomUUID()
  const row = await prisma.$transaction(async (tx) => {
    const active = await tx.job.findFirst({ where: { midName, status: { in: ACTIVE } }, select: { id: true } })
    if (active) throw new MidError("job_active")
    await extra?.(tx)
    const mid = await tx.midServer.findFirst({ where: { name: midName }, select: { id: true } })
    return tx.job.create({
      data: {
        id,
        midId: mid?.id ?? null,
        midName,
        kind,
        stage: k.stages[0].name,
        status: "queued",
        params: JSON.stringify(params),
        journalPath: journalPath(id),
        createdBy,
      },
    })
  })
  return row
}

export async function createJob(user: SessionPayload, kind: JobKind, midName: string, params: object): Promise<JobRow> {
  validateMidName(midName)
  assertNoSecrets(params)
  kindOrThrow(kind)
  const row = await withMidLock(midName, () => {
    assertNoZombie(midName)
    return insertJob(kind, midName, user.userId, params)
  })
  enqueue(row.id)
  return row
}

const RETRY_TOO_SOON = "งานยังปิดตัวไม่เสร็จ รอสักครู่แล้วกด ลองใหม่"

export async function retryJob(user: SessionPayload, id: string): Promise<JobRow> {
  const job = await prisma.job.findUnique({ where: { id } })
  if (!job) throw new MidError("job_not_found")
  if (user.role !== "admin" && !((job.kind === "install" || job.kind === "clone") && job.createdBy === user.userId)) {
    throw new MidError("forbidden")
  }
  if (job.status !== "failed") throw new MidError("conflict")
  kindOrThrow(job.kind as JobKind)
  const row = await withMidLock(job.midName, async () => {
    assertNoZombie(job.midName)
    // Still in its failure end window (journal/onFailure): enqueue would be dropped, so ask the user to retry shortly.
    // Own text: the shared job_running message talks about cancelling.
    if (state().running.has(id)) throw new MidError("job_running", 409, RETRY_TOO_SOON)
    const active = await prisma.job.findFirst({ where: { midName: job.midName, status: { in: ACTIVE } }, select: { id: true } })
    if (active) throw new MidError("job_active")
    const res = await prisma.job.updateMany({
      where: { id, status: "failed" },
      data: { status: "queued", attempt: { increment: 1 }, error: null, finishedAt: null },
    })
    if (res.count !== 1) throw new MidError("conflict")
    return prisma.job.findUniqueOrThrow({ where: { id } })
  })
  enqueue(id)
  await tryJournal(id, { type: "retry", attempt: row.attempt, stage: row.stage })
  return row
}

export async function cancelJob(user: SessionPayload, id: string): Promise<JobRow> {
  const job = await prisma.job.findUnique({ where: { id } })
  if (!job) throw new MidError("job_not_found")
  const isAdmin = user.role === "admin"
  const kind = job.kind as JobKind
  if (job.status === "running") throw new MidError("job_running")
  assertNoZombie(job.midName)

  if (job.status === "queued") {
    if (!isAdmin) throw new MidError("forbidden")
    const res = await prisma.job.updateMany({ where: { id, status: "queued" }, data: { status: "cancelled", finishedAt: new Date() } })
    if (res.count !== 1) throw new MidError("job_running")
    state().queue = state().queue.filter((q) => q !== id)
    await tryJournal(id, { type: "cancelled", by: user.userId })
    return prisma.job.findUniqueOrThrow({ where: { id } })
  }

  if (job.status !== "failed") throw new MidError("conflict")

  if (kind === "install" || kind === "clone") {
    if (!isAdmin && job.createdBy !== user.userId) throw new MidError("forbidden")
    kindOrThrow("cancel_install")
    const created = await withMidLock(job.midName, async () => {
      assertNoZombie(job.midName)
      if (state().running.has(id)) throw new MidError("job_running")
      const fresh = await prisma.job.findUniqueOrThrow({ where: { id } })
      if (fresh.status !== "failed") throw new MidError("conflict")
      return insertJob("cancel_install", job.midName, user.userId, { cancelOf: id, midId: job.midId }, async (tx) => {
        await tx.job.update({ where: { id }, data: { status: "cancelled", finishedAt: new Date() } })
      })
    })
    enqueue(created.id)
    await tryJournal(id, { type: "cancelled", by: user.userId, cleanupJob: created.id })
    return created
  }

  // failed uninstall / cancel_install: nothing to clean up; admin just closes the job.
  if (!isAdmin) throw new MidError("forbidden")
  await withMidLock(job.midName, async () => {
    const res = await prisma.job.updateMany({ where: { id, status: "failed" }, data: { status: "cancelled", finishedAt: new Date() } })
    if (res.count !== 1) throw new MidError("conflict")
  })
  await tryJournal(id, { type: "cancelled", by: user.userId })
  return prisma.job.findUniqueOrThrow({ where: { id } })
}

export async function resumeJobs(): Promise<number> {
  const rows = await prisma.job.findMany({ where: { status: { in: ACTIVE } }, orderBy: { updatedAt: "asc" }, select: { id: true } })
  let n = 0
  for (const r of rows) if (enqueue(r.id)) n++
  return n
}

// Returns false when the id is already queued or running (never schedule a job twice).
function enqueue(id: string): boolean {
  const st = state()
  if (st.running.has(id) || st.queue.includes(id)) return false
  st.queue.push(id)
  pump(st)
  return true
}

function pump(st: EngineState): void {
  while (st.running.size < MAX_CONCURRENT && st.queue.length) {
    const id = st.queue.shift() as string
    if (st.running.has(id)) continue
    st.running.add(id)
    const p: Promise<void> = execute(st, id)
      .catch((e) => console.error("[jobs] runner error", id, e))
      .finally(() => {
        st.running.delete(id)
        st.inflight.delete(p)
        pump(st)
      })
    st.inflight.add(p)
  }
}

const ACTIVE_STATUS = { in: ACTIVE }

// Runs fn with a timeout: abort the signal at timeoutMs, then reject via hardErr() after graceMs if fn still hasn't settled.
// The late settlement of fn is ignored. onHardStop receives the zombie run promise.
async function guarded(
  st: EngineState,
  jobId: string,
  label: string,
  timeoutMs: number,
  graceMs: number,
  fn: (signal: AbortSignal) => Promise<void>,
  hardErr: () => Error,
  opts: { heartbeat?: boolean; onHardStop?: (run: Promise<void>) => void } = {},
): Promise<void> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  st.abort.signal.addEventListener("abort", onAbort)
  if (st.abort.signal.aborted) ac.abort()
  const timers: ReturnType<typeof setTimeout>[] = []
  const heartbeat = opts.heartbeat
    ? setInterval(() => {
        prisma.job.updateMany({ where: { id: jobId, status: "running" }, data: { updatedAt: new Date() } }).catch(() => undefined)
      }, HEARTBEAT_MS)
    : undefined
  let run: Promise<void> = Promise.resolve()
  let hardStop!: (e: unknown) => void
  const stopped = new Promise<never>((_, rej) => (hardStop = rej))
  timers.push(
    setTimeout(() => {
      ac.abort()
      void tryJournal(jobId, { type: "log", level: "warn", msg: `${label} timed out; aborting` })
      timers.push(
        setTimeout(() => {
          opts.onHardStop?.(run)
          hardStop(hardErr())
        }, graceMs),
      )
    }, timeoutMs),
  )
  // Promise.resolve().then: a synchronous throw becomes a rejection handled below, never an unhandled one.
  run = Promise.resolve().then(() => fn(ac.signal))
  run.catch(() => undefined)
  try {
    await Promise.race([run, stopped])
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    timers.forEach(clearTimeout)
    st.abort.signal.removeEventListener("abort", onAbort)
  }
}

function runStage(st: EngineState, stage: Stage, job: JobRow, params: Record<string, unknown>): Promise<void> {
  return guarded(
    st,
    job.id,
    `stage ${stage.name}`,
    stage.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
    ABORT_GRACE_MS,
    (signal) =>
      stage.run({ job, params, signal, log: (msg, level = "info") => appendJournal(job.id, { type: "log", level, msg }) }),
    () => new MidError("stage_timeout", undefined, `ขั้นตอน ${stage.name} ใช้เวลานานเกินกำหนด งานถูกหยุด กด ลองใหม่ หรือแจ้ง Admin`),
    {
      heartbeat: true,
      onHardStop: (run) => {
        // Remember the zombie so a new job for this MID can't overlap with the still-running old stage.
        const name = job.midName
        const clear = () => {
          const t = st.zombies.get(name)
          if (t === timer) {
            clearTimeout(t)
            st.zombies.delete(name)
          }
        }
        const timer = setTimeout(clear, ZOMBIE_TTL_MS)
        timer.unref?.()
        st.zombies.set(name, timer)
        run.then(clear, clear)
      },
    },
  )
}

function runHook(st: EngineState, job: JobRow, name: string, ctx: JobCtx, fn: (ctx: JobCtx) => Promise<void>): Promise<void> {
  return guarded(
    st,
    job.id,
    `hook ${name}`,
    HOOK_TIMEOUT_MS,
    HOOK_GRACE_MS,
    (signal) => fn({ ...ctx, signal }),
    () => new MidError("internal", undefined, undefined, `hook ${name} ไม่ตอบสนอง (timeout)`),
  )
}

async function execute(st: EngineState, id: string): Promise<void> {
  let job = await prisma.job.findUnique({ where: { id } })
  if (!job || !ACTIVE.includes(job.status)) return
  const k = st.kinds.get(job.kind as JobKind)
  if (!k) {
    await failJob(job, new MidError("internal", undefined, undefined, `job kind "${job.kind}" is not registered`))
    return
  }
  const params = parseParams(job.params)
  if (!params) {
    await failJob(job, new MidError("internal", undefined, undefined, "params ไม่ถูกต้อง"))
    return
  }
  let idx = k.stages.findIndex((s) => s.name === job!.stage)
  if (idx < 0) {
    await failJob(job, new MidError("internal", undefined, undefined, `ไม่รู้จักขั้นตอนที่บันทึกไว้ "${job.stage}"`))
    return
  }
  let ctx: JobCtx = { job, params, signal: st.abort.signal, log: async () => undefined }
  try {
    for (; idx < k.stages.length; idx++) {
      const stage = k.stages[idx]
      // Awaited CAS before run(): a crash mid-stage resumes at this stage, and a cancelled job is never revived.
      const res = await prisma.job.updateMany({
        where: { id, status: ACTIVE_STATUS },
        data: { stage: stage.name, status: "running", ...(job.startedAt ? {} : { startedAt: new Date() }) },
      })
      if (res.count !== 1) return
      job = await prisma.job.findUniqueOrThrow({ where: { id } })
      await tryJournal(id, { type: "stage", stage: stage.name })
      ctx = { job, params, signal: st.abort.signal, log: (msg, level = "info") => appendJournal(id, { type: "log", level, msg }) }
      await runStage(st, stage, job, params)
    }
    if (k.hooks.onSuccess) await runHook(st, job, "onSuccess", ctx, k.hooks.onSuccess)
  } catch (err) {
    await failJob(job, err, k.hooks.onFailure ? (e) => runHook(st, job as JobRow, "onFailure", ctx, (c) => k.hooks.onFailure!(c, e)) : undefined)
    return
  }
  await writeOnce("success", id, async () => {
    const r = await prisma.job.updateMany({ where: { id, status: "running" }, data: { status: "succeeded", finishedAt: new Date(), error: null } })
    if (r.count === 1) await tryJournal(id, { type: "done" })
  })
}

async function failJob(job: JobRow, err: unknown, onFailure?: (e: unknown) => Promise<void>): Promise<void> {
  const me =
    err instanceof MidError
      ? err
      : new MidError("internal", undefined, undefined, err instanceof Error ? err.message : String(err))
  const detail = me.detail === undefined ? undefined : redact(me.detail)
  let changed = true
  await writeOnce("failure", job.id, async () => {
    const r = await prisma.job.updateMany({
      where: { id: job.id, status: ACTIVE_STATUS },
      data: { status: "failed", error: me.message, finishedAt: new Date() },
    })
    changed = r.count === 1
  })
  if (!changed) return
  await tryJournal(job.id, { type: "error", code: me.code, message: me.message, detail })
  if (onFailure) {
    try {
      await onFailure(err)
    } catch (e) {
      console.error(`[jobs] CRITICAL: onFailure hook for job ${job.id} did not complete`, e)
      await tryJournal(job.id, { type: "log", level: "error", msg: redact(`onFailure hook failed: ${e instanceof Error ? e.message : String(e)}`) })
    }
  }
}

/** Stage names of a registered kind (for the API/UI), or [] when the kind is not registered. */
export function kindStageNames(kind: string): string[] {
  return state().kinds.get(kind as JobKind)?.stages.map((s) => s.name) ?? []
}
