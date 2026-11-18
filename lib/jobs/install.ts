import { prisma } from "@/lib/db/client"
import { callHelper } from "@/lib/helper/client"
import { getInstanceSecret } from "@/lib/instances/service"
import { decryptSecret } from "@/lib/vault"
import { waitConnected } from "@/lib/mids/connected"
import { extractPackage } from "@/lib/mids/extract"
import { MIN_FREE_BYTES } from "@/lib/mids/layout"
import { MidError, validateMidName } from "@/lib/mids/names"
import { diskStatus, ensurePackage, gcPackages, packagePath } from "@/lib/mids/packages"
import { cloneFiles, configureMid } from "@/lib/mids/provision"
import { registerKind, type JobCtx, type Stage } from "./engine"

export type InstallParams = {
  instanceId: string
  buildstamp: string
  snName: string
  heapMb: number
  logFiles: number
  proxy?: { host: string; port: number; user?: string; passwordEnc?: string }
  cloneFrom?: string
}

/** Injected in tests. */
export const deps = { callHelper, ensurePackage, extractPackage, cloneFiles, configureMid, waitConnected, diskStatus, gcPackages }

const P = (ctx: JobCtx) => ctx.params as unknown as InstallParams & { startedAt?: string }
const name = (ctx: JobCtx) => ctx.job.midName

const precheck: Stage = {
  name: "precheck",
  async run(ctx) {
    const p = P(ctx)
    ctx.signal.throwIfAborted()
    validateMidName(name(ctx))
    const row = await prisma.midServer.findUnique({ where: { name: name(ctx) } })
    if (!row || row.state !== "installing") {
      throw new MidError("internal", undefined, undefined, "MID record ไม่อยู่ในสถานะติดตั้ง")
    }
    if (p.cloneFrom === name(ctx)) throw new MidError("invalid_request", undefined, undefined, "cloneFrom ต้องไม่ใช่ MID เดียวกับที่กำลังสร้าง")
    const { freeBytes } = await deps.diskStatus()
    if (freeBytes !== null && freeBytes < MIN_FREE_BYTES) throw new MidError("disk_low")
    const inst = await prisma.instance.findUnique({ where: { id: p.instanceId } })
    if (!inst) throw new MidError("not_found", undefined, "ไม่พบ instance ที่เลือก (อาจถูกลบแล้ว)")
    if (!inst.midUser || !inst.midPasswordEnc) {
      throw new MidError("invalid_request", 400, "instance นี้ยังไม่ได้ตั้ง MID user/password ไปตั้งที่หน้า Admin > Instances")
    }
    if (p.cloneFrom) {
      validateMidName(p.cloneFrom)
      const src = await prisma.midServer.findUnique({ where: { name: p.cloneFrom } })
      if (!src || src.state === "removed") throw new MidError("not_found", undefined, "ไม่พบ MID ต้นทางที่จะ clone (อาจถูกลบแล้ว)")
    }
  },
}

const fetchPackage: Stage = {
  name: "fetchPackage",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    let chain: Promise<unknown> = Promise.resolve()
    let lastPct = -5
    await deps.ensurePackage(P(ctx).buildstamp, {
      signal: ctx.signal,
      onProgress: (done, total) => {
        if (!total) return
        const pct = Math.min(100, Math.floor((done / total) * 100))
        if (pct === lastPct || (pct < lastPct + 5 && pct < 100)) return
        lastPct = pct
        chain = chain.then(() => ctx.log(`ดาวน์โหลด package ${pct}%`)).catch(() => undefined)
      },
    })
    await chain
  },
}

// Never re-run after fixOwnership: the engine only resumes at the failed stage, and nothing loops back.
const extract: Stage = {
  name: "extract",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    await deps.extractPackage(packagePath(P(ctx).buildstamp), name(ctx), ctx.job.id, ctx.signal)
  },
}

const copyFiles: Stage = {
  name: "copyFiles",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    const src = P(ctx).cloneFrom
    if (!src) return
    const r = await deps.cloneFiles(src, name(ctx), ctx.signal)
    for (const s of r.skipped) await ctx.log(`ข้ามไฟล์ ${s}`, "warn")
    for (const w of r.warnings) await ctx.log(w, "warn")
  },
}

const configure: Stage = {
  name: "configure",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    const p = P(ctx)
    const inst = await getInstanceSecret(p.instanceId)
    const proxy = p.proxy
      ? {
          host: p.proxy.host,
          port: p.proxy.port,
          ...(p.proxy.user ? { user: p.proxy.user } : {}),
          ...(p.proxy.passwordEnc ? { password: decryptSecret(p.proxy.passwordEnc) } : {}),
        }
      : undefined
    const r = await deps.configureMid(name(ctx), {
      url: inst.url,
      midUser: inst.midUser,
      password: inst.password,
      snName: p.snName,
      heapMb: p.heapMb,
      logFiles: p.logFiles,
      ...(proxy ? { proxy } : {}),
    })
    for (const w of r.warnings) await ctx.log(w, "warn")
  },
}

const fixOwnership: Stage = {
  name: "fixOwnership",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    await deps.callHelper({ op: "fixOwnership", name: name(ctx) })
  },
}

const installUnit: Stage = {
  name: "installUnit",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    await deps.callHelper({ op: "installUnit", name: name(ctx), heapMb: P(ctx).heapMb })
  },
}

const start: Stage = {
  name: "start",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    // Fresh timestamp per attempt so waitConnected never matches a previous run's marker.
    const startedAt = new Date().toISOString()
    // A set startedAt means an earlier attempt may already have started the unit; helper `start` would then
    // only enable it (no new connected marker), so use `restart` (which also checks quota).
    const retry = typeof ctx.params.startedAt === "string"
    ctx.params.startedAt = startedAt
    await prisma.job.update({ where: { id: ctx.job.id }, data: { params: JSON.stringify(ctx.params) } })
    await deps.callHelper({ op: retry ? "restart" : "start", name: name(ctx) })
  },
}

const waitConnectedStage: Stage = {
  name: "waitConnected",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    ctx.signal.throwIfAborted()
    const raw = P(ctx).startedAt ?? ctx.job.startedAt?.toISOString()
    const since = raw ? new Date(raw) : new Date(0)
    try {
      await deps.waitConnected(name(ctx), since, { signal: ctx.signal })
    } catch (e) {
      if (e instanceof MidError && e.code === "connect_timeout") {
        // The engine redacts/truncates error detail to 500 chars, so keep the full (sanitised) lines in the journal.
        for (const l of (e.detail ?? "").split("\n")) if (l) await ctx.log(l, "error")
        throw new MidError("connect_timeout", undefined, undefined, "ดูบรรทัด ERROR ใน log ของงานนี้")
      }
      throw e
    }
  },
}

export const installStages: Stage[] = [precheck, fetchPackage, extract, copyFiles, configure, fixOwnership, installUnit, start, waitConnectedStage]

async function onSuccess(ctx: JobCtx): Promise<void> {
  await prisma.midServer.update({ where: { name: name(ctx) }, data: { state: "installed", version: P(ctx).buildstamp } })
  try {
    await deps.gcPackages()
  } catch (e) {
    await ctx.log(`ล้าง package เก่าไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`, "warn")
  }
}

async function onFailure(ctx: JobCtx): Promise<void> {
  await prisma.midServer.updateMany({ where: { name: name(ctx) }, data: { state: "error" } })
}

export function registerInstallKinds(): void {
  for (const kind of ["install", "clone"] as const) registerKind(kind, installStages, { onSuccess, onFailure })
}
