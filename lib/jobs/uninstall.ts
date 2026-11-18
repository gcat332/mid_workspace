import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { prisma } from "@/lib/db/client"
import { callHelper } from "@/lib/helper/client"
import { ARCHIVE_PATHS } from "@/lib/mids/layout"
import { DEFAULT_MIDHUB_ROOT, MidError, midRoot, validateMidName } from "@/lib/mids/names"
import { gcPackages } from "@/lib/mids/packages"
import { fdPath, insideCheck, lstatIn, openDir, removeIn } from "@/lib/mids/safe-fs"
import { registerKind, type JobCtx, type Stage } from "./engine"

/** Injected in tests. */
export const deps = { callHelper, gcPackages }

export const limits = { archiveMaxBytes: 1024 ** 3 }
const ARCHIVE_MAX_BYTES = () => limits.archiveMaxBytes
export const ARCHIVE_RETENTION_MS = 30 * 24 * 3600_000
const TAR = "/usr/bin/tar"
const TAR_ENV: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }
const C = fs.constants

const rootDir = () => process.env.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT
const archiveDirPath = () => path.join(rootDir(), "archive")
const enoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT"
const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" })
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)

/** Real path of mids/ (null when it does not exist). */
async function midsReal(name: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(path.join(midRoot(name), ".."))
  } catch (e) {
    if (enoent(e)) return null
    throw e
  }
}

/**
 * Archives only the mutable files (config, conf, extlib, security, properties, logs), never lib/jre/bin.
 * tar runs as the app user, pinned to the verified agent/ directory through an inherited fd, so a swapped
 * path cannot redirect it. Symlinks are stored as links (never dereferenced); FIFOs are stored, not opened.
 * Deviation from the brief: tar streams to stdout and we write the file ourselves to enforce the size cap.
 */
export async function archiveMid(name: string, signal?: AbortSignal, onWarn?: (m: string) => void | Promise<void>): Promise<string> {
  validateMidName(name)
  signal?.throwIfAborted()
  const mids = await midsReal(name)
  if (!mids) throw new MidError("not_found")
  const midsDir = await openDir(mids, insideCheck(mids))
  try {
    const midSt = await lstatIn(midsDir, name)
    if (!midSt || !midSt.isDirectory()) throw new MidError("not_found")
    const agentReal = path.join(mids, name, "agent")
    const midDir = await openDir(path.join(mids, name), (r) => {
      if (r !== path.join(mids, name)) throw new MidError("path_outside")
    })
    let agentDir
    try {
      const st = await lstatIn(midDir, "agent")
      if (!st || !st.isDirectory()) throw new MidError("not_found")
      agentDir = await openDir(agentReal, (r) => {
        if (r !== agentReal) throw new MidError("path_outside")
      })
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
      if (!entries.length) throw new MidError("not_found")
      return await runTar(name, agentDir.fd, entries, signal, onWarn)
    } finally {
      await agentDir.close()
    }
  } finally {
    await midsDir.close()
  }
}

async function runTar(name: string, agentFd: number, entries: string[], signal: AbortSignal | undefined, onWarn?: (m: string) => void | Promise<void>): Promise<string> {
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
      // Names are prefixed with agent/ by --transform (r = regular member names only, so link targets stay untouched).
      const args = ["--one-file-system", "--warning=no-file-changed", "--transform=flags=r;s,^,agent/,", "-czf", "-", "-C", "/proc/self/fd/3", "--", ...entries]
      const stdio: StdioOptions = ["ignore", "pipe", "pipe", agentFd]
      const child: ChildProcess = spawn(TAR, args, { stdio, env: TAR_ENV as NodeJS.ProcessEnv, signal })
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
          if (bytes > ARCHIVE_MAX_BYTES()) {
            tooBig = true
            throw new Error("archive too large")
          }
          await out.write(chunk)
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

/** Fd-anchored removal of mids/<name>; already gone is a no-op. Ownership must already be fixed (stage fixOwnership). */
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
      if (enoent(e)) return
      throw new MidError("internal", undefined, undefined, "ลบโฟลเดอร์ MID ไม่สำเร็จ (สิทธิ์ไม่พอหรือไฟล์ถูกใช้งานอยู่) ลองสั่งใหม่อีกครั้ง")
    }
  } finally {
    await midsDir.close()
  }
}

const name = (ctx: JobCtx) => ctx.job.midName

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

const stop: Stage = { name: "stop", run: (ctx) => helperTolerant(ctx, "stop") }
const removeUnit: Stage = { name: "removeUnit", run: (ctx) => helperTolerant(ctx, "removeUnit") }
// Controller ruling: before archive (not inside deleteMidDir) so tar can read files the MID created 0600.
const fixOwnership: Stage = { name: "fixOwnership", run: (ctx) => helperTolerant(ctx, "fixOwnership") }

const archive: Stage = {
  name: "archive",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    try {
      const p = await archiveMid(name(ctx), ctx.signal, (m) => ctx.log(m, "warn"))
      await ctx.log(`สำรองไฟล์ไว้ที่ ${p}`)
    } catch (e) {
      if (e instanceof MidError && e.code === "not_found") {
        await ctx.log("ไม่พบโฟลเดอร์ MID ข้ามการสำรอง", "warn")
        return
      }
      throw e
    }
  },
}

const deleteDir: Stage = {
  name: "deleteDir",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    await deleteMidDir(name(ctx))
  },
}

const markRemoved: Stage = {
  name: "markRemoved",
  async run(ctx) {
    ctx.signal.throwIfAborted()
    await prisma.midServer.updateMany({ where: { name: name(ctx) }, data: { state: "removed", removedAt: new Date() } })
  },
}

export const uninstallStages: Stage[] = [stop, removeUnit, fixOwnership, archive, deleteDir, markRemoved]
export const cancelInstallStages: Stage[] = [stop, removeUnit, fixOwnership, deleteDir, markRemoved]

async function onSuccess(ctx: JobCtx): Promise<void> {
  try {
    await deps.gcPackages()
  } catch (e) {
    await ctx.log(`ล้าง package เก่าไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`, "warn")
  }
}

/** Deletes archive/*.tar.gz older than 30 days (by mtime). Never follows symlinks; non-regular entries are skipped. */
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
      if (!n.endsWith(".tar.gz")) continue
      const p = fdPath(dir, n)
      const st = await fs.promises.lstat(p).catch(() => null)
      if (!st || !st.isFile()) continue
      if (now.getTime() - st.mtimeMs <= ARCHIVE_RETENTION_MS) continue
      await fs.promises.unlink(p).catch(() => undefined)
      deleted.push(path.join(real, n))
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
