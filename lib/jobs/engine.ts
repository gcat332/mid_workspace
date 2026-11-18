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
export type Stage = { name: string; run(ctx: JobCtx): Promise<void> }
export type KindHooks = {
  onSuccess?(ctx: JobCtx): Promise<void>
  onFailure?(ctx: JobCtx, err: unknown): Promise<void>
}

const MAX_CONCURRENT = 2
const STATE_KEY = Symbol.for("midhub.jobEngine")

interface EngineState {
  kinds: Map<JobKind, { stages: Stage[]; hooks: KindHooks }>
  queue: string[]
  running: Set<string>
  inflight: Set<Promise<void>>
  locks: Map<string, Promise<unknown>>
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

function parseParams(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
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
  const row = await withMidLock(midName, () => insertJob(kind, midName, user.userId, params))
  enqueue(row.id)
  return row
}

export async function retryJob(user: SessionPayload, id: string): Promise<JobRow> {
  void user // any authenticated user may retry (Global Constraints)
  const job = await prisma.job.findUnique({ where: { id } })
  if (!job) throw new MidError("job_not_found")
  if (job.status !== "failed") throw new MidError("conflict")
  kindOrThrow(job.kind as JobKind)
  const row = await withMidLock(job.midName, async () => {
    const active = await prisma.job.findFirst({ where: { midName: job.midName, status: { in: ACTIVE } }, select: { id: true } })
    if (active) throw new MidError("job_active")
    const res = await prisma.job.updateMany({
      where: { id, status: "failed" },
      data: { status: "queued", attempt: { increment: 1 }, error: null, finishedAt: null },
    })
    if (res.count !== 1) throw new MidError("conflict")
    return prisma.job.findUniqueOrThrow({ where: { id } })
  })
  await appendJournal(id, { type: "retry", attempt: row.attempt, stage: row.stage })
  enqueue(id)
  return row
}

export async function cancelJob(user: SessionPayload, id: string): Promise<JobRow> {
  const job = await prisma.job.findUnique({ where: { id } })
  if (!job) throw new MidError("job_not_found")
  const isAdmin = user.role === "admin"
  const kind = job.kind as JobKind
  if (job.status === "running") throw new MidError("job_running")

  if (job.status === "queued") {
    if (!isAdmin) throw new MidError("forbidden")
    const res = await prisma.job.updateMany({ where: { id, status: "queued" }, data: { status: "cancelled", finishedAt: new Date() } })
    if (res.count !== 1) throw new MidError("job_running")
    state().queue = state().queue.filter((q) => q !== id)
    await appendJournal(id, { type: "cancelled", by: user.userId })
    return prisma.job.findUniqueOrThrow({ where: { id } })
  }

  if (job.status !== "failed") throw new MidError("conflict")

  if (kind === "install" || kind === "clone") {
    if (!isAdmin && job.createdBy !== user.userId) throw new MidError("forbidden")
    kindOrThrow("cancel_install")
    const created = await withMidLock(job.midName, async () => {
      const fresh = await prisma.job.findUniqueOrThrow({ where: { id } })
      if (fresh.status !== "failed") throw new MidError("conflict")
      return insertJob("cancel_install", job.midName, user.userId, { cancelOf: id, midId: job.midId }, async (tx) => {
        await tx.job.update({ where: { id }, data: { status: "cancelled", finishedAt: new Date() } })
      })
    })
    await appendJournal(id, { type: "cancelled", by: user.userId, cleanupJob: created.id })
    enqueue(created.id)
    return created
  }

  // failed uninstall / cancel_install: nothing to clean up; admin just closes the job.
  if (!isAdmin) throw new MidError("forbidden")
  await prisma.job.update({ where: { id }, data: { status: "cancelled", finishedAt: new Date() } })
  await appendJournal(id, { type: "cancelled", by: user.userId })
  return prisma.job.findUniqueOrThrow({ where: { id } })
}

export async function resumeJobs(): Promise<number> {
  const st = state()
  const rows = await prisma.job.findMany({ where: { status: { in: ACTIVE } }, orderBy: { updatedAt: "asc" }, select: { id: true } })
  let n = 0
  for (const r of rows) {
    if (st.running.has(r.id) || st.queue.includes(r.id)) continue
    enqueue(r.id)
    n++
  }
  return n
}

function enqueue(id: string): void {
  const st = state()
  st.queue.push(id)
  pump(st)
}

function pump(st: EngineState): void {
  while (st.running.size < MAX_CONCURRENT && st.queue.length) {
    const id = st.queue.shift() as string
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

async function execute(st: EngineState, id: string): Promise<void> {
  let job = await prisma.job.findUnique({ where: { id } })
  if (!job || !ACTIVE.includes(job.status)) return
  const k = st.kinds.get(job.kind as JobKind)
  if (!k) {
    await failJob(job, new MidError("internal", undefined, undefined, `job kind "${job.kind}" is not registered`), undefined)
    return
  }
  const params = parseParams(job.params)
  let idx = k.stages.findIndex((s) => s.name === job!.stage)
  if (idx < 0) idx = 0
  const mkCtx = (j: JobRow): JobCtx => ({
    job: j,
    params,
    signal: st.abort.signal,
    log: (msg, level = "info") => appendJournal(j.id, { type: "log", level, msg }),
  })
  let ctx = mkCtx(job)
  try {
    for (; idx < k.stages.length; idx++) {
      const stage = k.stages[idx]
      // Awaited before run(): a crash mid-stage resumes at this stage.
      job = await prisma.job.update({
        where: { id },
        data: { stage: stage.name, status: "running", startedAt: job.startedAt ?? new Date() },
      })
      ctx = mkCtx(job)
      await appendJournal(id, { type: "stage", stage: stage.name })
      await stage.run(ctx)
    }
    await k.hooks.onSuccess?.(ctx)
  } catch (err) {
    await failJob(job, err, k.hooks.onFailure ? (e) => k.hooks.onFailure!(ctx, e) : undefined)
    return
  }
  await prisma.job.update({ where: { id }, data: { status: "succeeded", finishedAt: new Date(), error: null } })
  await appendJournal(id, { type: "done" }).catch(() => undefined)
}

async function failJob(job: JobRow, err: unknown, onFailure?: (e: unknown) => Promise<void>): Promise<void> {
  const me =
    err instanceof MidError
      ? err
      : new MidError("internal", undefined, undefined, err instanceof Error ? err.message : String(err))
  await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: me.message, finishedAt: new Date() } })
  await appendJournal(job.id, { type: "error", code: me.code, message: me.message, detail: me.detail }).catch(() => undefined)
  if (onFailure) {
    try {
      await onFailure(err)
    } catch (e) {
      await appendJournal(job.id, { type: "log", level: "error", msg: `onFailure hook failed: ${e instanceof Error ? e.message : String(e)}` }).catch(() => undefined)
    }
  }
}
