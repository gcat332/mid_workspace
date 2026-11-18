import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import fs from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { prisma } from "@/lib/db/client"
import { callHelper } from "@/lib/helper/client"
import { ARCHIVE_PATHS } from "@/lib/mids/layout"
import { DEFAULT_MIDHUB_ROOT, MidError, midRoot, validateMidName } from "@/lib/mids/names"
import { gcPackages } from "@/lib/mids/packages"
import { fdPath, insideCheck, lstatIn, openDir, openDirIn, removeIn, translateFsError } from "@/lib/mids/safe-fs"
import { registerKind, type JobCtx, type Stage } from "./engine"

/** Injected in tests. */
export const deps = { callHelper, gcPackages }

export const limits = { archiveMaxBytes: 1024 ** 3, preWalkMaxBytes: 2 * 1024 ** 3, maxEntries: 20000, retryArchiveMs: 8 * 60_000 }
const PARTIAL_RETENTION_MS = 24 * 3600_000
export const ARCHIVE_RETENTION_MS = 30 * 24 * 3600_000
/** Path is overridable in tests only. */
export const tarBin = { path: "/usr/bin/tar" }
const TAR_ENV: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }
const C = fs.constants

const rootDir = () => process.env.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT
const archiveDirPath = () => path.join(rootDir(), "archive")
const enoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT"
const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" })
const p2 = (n: number) => String(n).padStart(2, "0")
const stamp = (d: Date) =>
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`

/** Real path of mids/ (null when it does not exist). */
async function midsReal(name: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(path.join(midRoot(name), ".."))
  } catch (e) {
    if (enoent(e)) return null
    throw e
  }
}

type Warn = (m: string) => void | Promise<void>
const SKIP_BIG = "ข้ามการเก็บ archive: ข้อมูลใหญ่เกิน 2 GB หรือไฟล์เกิน 20000 — ลบต่อโดยไม่เก็บ archive"
const SKIP_EMPTY = "ไม่มีไฟล์ให้เก็บ archive"
const MAX_DEPTH = 64

/** Logical size (st.size, sparse files count in full) and entry count of the selected entries; never follows symlinks. */
async function preWalk(agentDir: FileHandle, entries: string[]): Promise<{ exceeded: boolean }> {
  let size = 0
  let count = 0
  const over = () => size > limits.preWalkMaxBytes || count > limits.maxEntries
  async function walk(dir: FileHandle, name: string, depth: number): Promise<void> {
    const st = await fs.promises.lstat(fdPath(dir, name))
    count++
    if (st.isDirectory()) {
      if (depth >= MAX_DEPTH) {
        size = Infinity
        return
      }
      const h = await openDirIn(dir, name)
      try {
        for (const n of await fs.promises.readdir(fdPath(h))) {
          await walk(h, n, depth + 1)
          if (over()) return
        }
      } finally {
        await h.close()
      }
    } else if (st.isFile()) size += st.size
  }
  for (const e of entries) {
    await walk(agentDir, e, 0)
    if (over()) return { exceeded: true }
  }
  return { exceeded: over() }
}

/**
 * Archives only the mutable files (config, conf, extlib, security, properties, logs), never lib/jre/bin.
 * tar runs as the app user, pinned to the verified agent/ directory through an inherited fd, so a swapped
 * path cannot redirect it. Symlinks are stored as links (never dereferenced); FIFOs are stored, not opened.
 * Deviation from the brief: tar streams to stdout and we write the file ourselves to enforce the size cap.
 * Returns the archive path, or null when archiving was skipped (nothing to archive, or too big; a warning is passed to onWarn).
 */
export async function archiveMid(name: string, signal?: AbortSignal, onWarn?: Warn): Promise<string | null> {
  validateMidName(name)
  signal?.throwIfAborted()
  try {
    return await archiveInner(name, signal, onWarn)
  } catch (e) {
    if (e instanceof MidError || (e as Error)?.name === "AbortError") throw e
    // Only the explicit midsDir/midDir/agentDir checks mean "folder missing"; any other ENOENT (spawn of tar, a file that
    // vanished during the pre-walk) is a real failure and must follow the first-attempt-fails / retry-skips rule.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new MidError("internal", undefined, undefined, `สำรอง archive ไม่สำเร็จ: ไฟล์หรือโปรแกรมหายไประหว่างทำงาน (${(e as NodeJS.ErrnoException).syscall ?? "ENOENT"})`)
    }
    return translateFsError(e)
  }
}

async function archiveInner(name: string, signal: AbortSignal | undefined, onWarn?: Warn): Promise<string | null> {
  const mids = await midsReal(name)
  if (!mids) throw new MidError("not_found")
  const midsDir = await openDir(mids, insideCheck(mids))
  try {
    if (!(await lstatIn(midsDir, name))) throw new MidError("not_found")
    const midDir = await openDirIn(midsDir, name).catch(notDir)
    let agentDir: FileHandle
    try {
      agentDir = await openDirIn(midDir, "agent").catch(notDir)
    } finally {
      await midDir.close()
    }
    try {
      const entries: string[] = []
      for (const rel of ARCHIVE_PATHS) {
        const sub = rel.replace(/^agent\//, "")
        const st = await lstatIn(agentDir, sub)
        if (st && !st.isSymbolicLink()) entries.push(sub)
      }
      if (!entries.length) {
        await onWarn?.(SKIP_EMPTY)
        return null
      }
      if ((await preWalk(agentDir, entries)).exceeded) {
        await onWarn?.(SKIP_BIG)
        return null
      }
      return await runTar(name, agentDir.fd, entries, signal, onWarn)
    } finally {
      await agentDir.close()
    }
  } finally {
    await midsDir.close()
  }
}

function notDir(e: unknown): never {
  if (e instanceof MidError || (e as NodeJS.ErrnoException)?.code === "ENOENT") throw new MidError("not_found")
  throw e
}

async function writeAll(h: FileHandle, chunk: Buffer): Promise<void> {
  let off = 0
  while (off < chunk.length) {
    const { bytesWritten } = await h.write(chunk, off, chunk.length - off)
    off += bytesWritten
  }
}

async function runTar(name: string, agentFd: number, entries: string[], signal: AbortSignal | undefined, onWarn?: Warn): Promise<string> {
  await fs.promises.mkdir(archiveDirPath(), { recursive: true, mode: 0o750 })
  const archReal = await fs.promises.realpath(archiveDirPath())
  const arch = await openDir(archReal, (r) => {
    if (r !== archReal) throw new MidError("path_outside")
  })
  const tmpName = `.${name}-${process.pid}-${Date.now()}.partial`
  const finalName = `${name}-${stamp(new Date())}.tar.gz`
  try {
    const out = await fs.promises.open(fdPath(arch, tmpName), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o640)
    let ok = false
    try {
      await out.chmod(0o640)
      // Names are prefixed with agent/ by --transform (r = member names, h = hard-link targets; symlink targets stay untouched).
      const args = ["--one-file-system", "--sparse", "--warning=no-file-changed", "--transform=flags=rh;s,^,agent/,", "-czf", "-", "-C", "/proc/self/fd/3", "--", ...entries]
      const stdio: StdioOptions = ["ignore", "pipe", "pipe", agentFd]
      const child: ChildProcess = spawn(tarBin.path, args, { stdio, env: TAR_ENV as NodeJS.ProcessEnv, signal })
      let stderr = ""
      child.stderr!.setEncoding("utf8")
      child.stderr!.on("data", (c: string) => {
        if (stderr.length < 2000) stderr += c
      })
      const exit = new Promise<number>((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) => resolve(code ?? 2))
      })
      exit.catch(() => undefined)
      let bytes = 0
      let tooBig = false
      try {
        for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
          bytes += chunk.length
          if (bytes > limits.archiveMaxBytes) {
            tooBig = true
            throw new Error("archive too large")
          }
          await writeAll(out, chunk)
        }
      } catch (e) {
        child.kill("SIGKILL")
        await exit.catch(() => undefined)
        if (tooBig) throw new MidError("internal", undefined, undefined, "ไฟล์ archive ใหญ่เกิน 1 GiB จึงยกเลิกการสำรอง")
        if (signal?.aborted) throw abortErr()
        throw e
      }
      let code: number
      try {
        code = await exit
      } catch (e) {
        if (signal?.aborted) throw abortErr()
        throw e
      }
      if (signal?.aborted) throw abortErr()
      if (code === 1) await onWarn?.("tar แจ้งว่าบางไฟล์เปลี่ยนระหว่างสำรอง (ข้ามได้)")
      else if (code !== 0) throw new MidError("internal", undefined, undefined, `tar ล้มเหลว (exit ${code}): ${stderr.trim().slice(0, 500)}`)
      await out.datasync()
      ok = true
    } finally {
      await out.close()
      if (!ok) await fs.promises.unlink(fdPath(arch, tmpName)).catch(() => undefined)
    }
    await fs.promises.rename(fdPath(arch, tmpName), fdPath(arch, finalName))
    return path.join(archReal, finalName)
  } finally {
    await arch.close()
  }
}

/** Fd-anchored removal of mids/<name>; already gone is a no-op. Ownership must already be fixed (the stage does that). */
export async function deleteMidDir(name: string): Promise<void> {
  validateMidName(name)
  const mids = await midsReal(name)
  if (!mids) return
  const midsDir = await openDir(mids, insideCheck(mids))
  try {
    if (!(await lstatIn(midsDir, name))) return
    try {
      await removeIn(midsDir, mids, name, insideCheck(mids))
    } catch (e) {
      if (e instanceof MidError) {
        if (e.code === "not_found") return
        throw e
      }
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === "ENOENT") return
      if (code === "ENOSPC") throw new MidError("disk_full")
      throw new MidError("internal", undefined, undefined, `ลบโฟลเดอร์ MID ไม่สำเร็จ (${code ?? "unknown"}: สิทธิ์ไม่พอหรือไฟล์ถูกใช้งานอยู่) ลองสั่งใหม่อีกครั้ง`)
    }
  } finally {
    await midsDir.close()
  }
}

const name = (ctx: JobCtx) => ctx.job.midName
const CONFLICT_DETAIL = "MID นี้ถูกเปลี่ยนสถานะไปแล้ว งานนี้ใช้ไม่ได้"

/** The row must be this job's own row and in the state its kind expects, else a stale retry could hit a re-installed MID. */
async function gate(ctx: JobCtx, expected: readonly string[], allowRemoved = false): Promise<"ok" | "removed"> {
  // A row id can be reused (revive / re-import), so also refuse when a newer job exists for this name: this job is from an older lifecycle.
  const newer = await prisma.job.findFirst({ where: { midName: name(ctx), createdAt: { gt: ctx.job.createdAt } }, select: { id: true } })
  if (newer) throw new MidError("conflict", undefined, undefined, CONFLICT_DETAIL)
  const row = await prisma.midServer.findUnique({ where: { name: name(ctx) } })
  if (!row || !ctx.job.midId || row.id !== ctx.job.midId) throw new MidError("conflict", undefined, undefined, CONFLICT_DETAIL)
  if (expected.includes(row.state)) return "ok"
  if (allowRemoved && row.state === "removed") return "removed"
  throw new MidError("conflict", undefined, undefined, CONFLICT_DETAIL)
}

/** Helper "not_found" (unit or directory never existed / already removed) is success for idempotency. */
async function helperTolerant(ctx: JobCtx, op: "stop" | "removeUnit" | "fixOwnership"): Promise<void> {
  ctx.signal.throwIfAborted()
  try {
    await deps.callHelper({ op, name: name(ctx) })
  } catch (e) {
    if (e instanceof MidError && e.code === "not_found") return
    throw e
  }
}

function stagesFor(kind: "uninstall" | "cancel_install"): Stage[] {
  const expected = kind === "uninstall" ? ["uninstalling"] : ["installing", "error"]
  const helperStage = (op: "stop" | "removeUnit"): Stage => ({
    name: op,
    async run(ctx) {
      await gate(ctx, expected)
      await helperTolerant(ctx, op)
    },
  })
  const archive: Stage = {
    name: "archive",
    timeoutMs: 10 * 60_000,
    async run(ctx) {
      await gate(ctx, expected)
      // Archive is best-effort. On a retry (attempt >= 1) a failure or timeout is journalled and skipped; the first attempt fails loudly.
      const retry = ctx.job.attempt >= 1
      const signal = retry ? AbortSignal.any([ctx.signal, AbortSignal.timeout(limits.retryArchiveMs)]) : ctx.signal
      try {
        // Re-normalise ownership: a retry starting here must still be able to read everything.
        await helperTolerant(ctx, "fixOwnership")
        const p = await archiveMid(name(ctx), signal, (m) => ctx.log(m, "warn"))
        if (p) await ctx.log(`สำรองไฟล์ไว้ที่ ${p}`)
      } catch (e) {
        ctx.signal.throwIfAborted()
        if (e instanceof MidError && e.code === "not_found") {
          await ctx.log("ไม่พบโฟลเดอร์ MID ข้ามการสำรอง", "warn")
          return
        }
        if (!retry) throw e
        const why = e instanceof MidError ? (e.detail ?? e.message) : (e as Error)?.name === "AbortError" ? "หมดเวลา" : "เกิดข้อผิดพลาด"
        await ctx.log(`ข้ามการเก็บ archive หลังพยายามซ้ำไม่สำเร็จ (${why}) — ลบต่อโดยไม่เก็บ archive`, "warn")
      }
    },
  }
  const deleteDir: Stage = {
    name: "deleteDir",
    async run(ctx) {
      await gate(ctx, expected)
      await helperTolerant(ctx, "fixOwnership")
      ctx.signal.throwIfAborted()
      await deleteMidDir(name(ctx))
    },
  }
  const markRemoved: Stage = {
    name: "markRemoved",
    async run(ctx) {
      ctx.signal.throwIfAborted()
      if ((await gate(ctx, expected, true)) === "removed") return
      const r = await prisma.midServer.updateMany({
        where: { id: ctx.job.midId!, state: { in: expected } },
        data: { state: "removed", removedAt: new Date() },
      })
      if (r.count === 0) throw new MidError("conflict", undefined, undefined, CONFLICT_DETAIL)
    },
  }
  return kind === "uninstall"
    ? [helperStage("stop"), helperStage("removeUnit"), archive, deleteDir, markRemoved]
    : [helperStage("stop"), helperStage("removeUnit"), deleteDir, markRemoved]
}

export const uninstallStages: Stage[] = stagesFor("uninstall")
export const cancelInstallStages: Stage[] = stagesFor("cancel_install")

async function onSuccess(ctx: JobCtx): Promise<void> {
  try {
    await deps.gcPackages()
  } catch (e) {
    await ctx.log(`ล้าง package เก่าไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`, "warn")
  }
}

/**
 * Deletes archive/*.tar.gz older than 30 days (by mtime) and stale .*.partial leftovers older than 1 day.
 * Never follows symlinks; non-regular entries are skipped. Returns only files actually unlinked.
 */
export async function sweepArchives(now: Date = new Date()): Promise<string[]> {
  let real: string
  try {
    real = await fs.promises.realpath(archiveDirPath())
  } catch (e) {
    if (enoent(e)) return []
    throw e
  }
  const dir = await openDir(real, (r) => {
    if (r !== real) throw new MidError("path_outside")
  })
  const deleted: string[] = []
  try {
    for (const n of await fs.promises.readdir(fdPath(dir))) {
      const partial = n.startsWith(".") && n.endsWith(".partial")
      if (!partial && !n.endsWith(".tar.gz")) continue
      const p = fdPath(dir, n)
      const st = await fs.promises.lstat(p).catch(() => null)
      if (!st || !st.isFile()) continue
      if (now.getTime() - st.mtimeMs <= (partial ? PARTIAL_RETENTION_MS : ARCHIVE_RETENTION_MS)) continue
      try {
        await fs.promises.unlink(p)
        deleted.push(path.join(real, n))
      } catch (e) {
        console.error("[archive] sweep could not delete", n, (e as NodeJS.ErrnoException)?.code)
      }
    }
  } finally {
    await dir.close()
  }
  return deleted
}

export function registerUninstallKinds(): void {
  registerKind("uninstall", uninstallStages, { onSuccess })
  registerKind("cancel_install", cancelInstallStages, { onSuccess })
}
