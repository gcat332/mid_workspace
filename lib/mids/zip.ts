import fs from "node:fs"
import path from "node:path"
import type { FileHandle } from "node:fs/promises"
import { zipStream, type ZipSource } from "@/lib/zip/writer"
import { ctxFor, plainName, readCheck, UPLOAD_TMP_RE } from "./files"
import { MidError } from "./names"
import { resolveMidPath } from "./paths"
import { fdPath, lstatIn, mapFsErrors, openDir, openDirIn, openFile } from "./safe-fs"

export const ZIP_MAX_BYTES = 1024 ** 3
export const ZIP_MAX_FILES = 10_000
// Directories are not "files" but still cost memory in the plan and a central-directory record each.
const MAX_ENTRIES = 2 * ZIP_MAX_FILES
const TOO_LARGE_MSG = "ไฟล์ที่เลือกรวมกันใหญ่เกิน 1 GB หรือเกิน 10,000 ไฟล์ เลือกโฟลเดอร์ย่อยหรือไฟล์น้อยลงแล้วลองใหม่"

export type ZipPlan = {
  files: number; bytes: number; filename: string
  /** rel: path below the MID root (posix); zipName: name inside the archive (dirs end with "/"). */
  entries: { rel: string; zipName: string; dir: boolean; size: number; mtime: Date }[]
}

const TOO_MANY_MSG = "โฟลเดอร์ที่เลือกมีไฟล์และโฟลเดอร์ย่อยมากเกินไป (เกิน 20,000 รายการ) เลือกโฟลเดอร์ย่อยหรือไฟล์น้อยลงแล้วลองใหม่"
const tooLarge = () => new MidError("too_large", 413, TOO_LARGE_MSG)

export function planZip(name: string, dir: string, names: string[]): Promise<ZipPlan> {
  return mapFsErrors(async () => {
    const c = await ctxFor(name)
    const dirRel = dir.replace(/\\/g, "/").split("/").filter((x) => x !== "" && x !== ".").join("/")
    const dirAbs = await resolveMidPath(name, dirRel)
    const check = readCheck(c)
    const entries: ZipPlan["entries"] = []
    let files = 0
    let bytes = 0
    let sawConfig = false
    const push = (e: ZipPlan["entries"][number]) => {
      if (e.dir) {
        if (entries.length >= MAX_ENTRIES) throw new MidError("too_large", 413, TOO_MANY_MSG)
      } else {
        files++
        bytes += e.size
        if (files > ZIP_MAX_FILES || bytes > ZIP_MAX_BYTES) throw tooLarge()
      }
      entries.push(e)
    }

    /** Adds one child of an open directory (symlinks, config.xml, upload temp files are skipped). */
    const addChild = async (d: FileHandle, dReal: string, dRel: string, n: string, zipPrefix: string, mode: "walk" | "single" | "multi"): Promise<void> => {
      const strict = mode === "single"
      const abs = path.join(dReal, n)
      const rel = dRel ? `${dRel}/${n}` : n
      const st = await lstatIn(d, n)
      if (!st) {
        if (mode !== "walk") throw new MidError("not_found")
        return
      }
      if (c.configXml.includes(abs)) sawConfig = true
      if (strict && c.configXml.includes(abs)) throw new MidError("use_config_tab")
      if (st.isSymbolicLink() || UPLOAD_TMP_RE.test(n) || c.configXml.includes(abs)) {
        if (strict) throw new MidError("not_found") // an explicitly selected entry must not silently vanish
        return
      }
      if (st.isDirectory()) {
        push({ rel, zipName: `${zipPrefix}${n}/`, dir: true, size: 0, mtime: st.mtime })
        const sub = await openDirIn(d, n)
        try {
          await walk(sub, abs, rel, `${zipPrefix}${n}/`)
        } finally {
          await sub.close()
        }
      } else if (st.isFile()) {
        push({ rel, zipName: `${zipPrefix}${n}`, dir: false, size: st.size, mtime: st.mtime })
      }
    }
    const walk = async (d: FileHandle, dReal: string, dRel: string, zipPrefix: string): Promise<void> => {
      for (const n of (await fs.promises.readdir(fdPath(d))).sort()) await addChild(d, dReal, dRel, n, zipPrefix, "walk")
    }

    const base = dirRel ? path.posix.basename(dirRel) : name
    const d = await openDir(dirAbs, check)
    try {
      if (names.length === 0) {
        const st = await d.stat()
        push({ rel: dirRel, zipName: `${base}/`, dir: true, size: 0, mtime: st.mtime })
        await walk(d, dirAbs, dirRel, `${base}/`)
      } else {
        const uniq = [...new Set(names)]
        for (const n of uniq) plainName(n)
        // One name is an explicit request (its exclusion is an error); among several, excluded ones are skipped like in a folder walk.
        for (const n of uniq) await addChild(d, dirAbs, dirRel, n, "", uniq.length === 1 ? "single" : "multi")
        if (entries.length === 0) throw new MidError(sawConfig ? "use_config_tab" : "not_found")
      }
    } finally {
      await d.close()
    }
    const filename = uniqNames(names).length === 1 ? `${uniqNames(names)[0]}.zip` : `${base}.zip`
    return { files, bytes, filename, entries }
  })
}

const uniqNames = (names: string[]): string[] => [...new Set(names)]

const SKIP_CODES = new Set(["not_found", "path_outside", "invalid_request", "use_config_tab"])
const SKIP_ERRNO = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENXIO"])

/** Streams the planned entries: each file is re-opened without following links and cut at its planned size. */
export function zipPlanStream(name: string, plan: ZipPlan): ReadableStream<Uint8Array> {
  const ctx = ctxFor(name)
  ctx.catch(() => {}) // surfaced by the first open; never an unhandled rejection
  const sources = async function* (): AsyncGenerator<ZipSource> {
    for (const e of plan.entries) {
      if (e.dir) { yield { name: e.zipName, mtime: e.mtime, dir: true }; continue }
      yield {
        name: e.zipName, mtime: e.mtime,
        open: async () => {
          const c = await ctx // a failed MID lookup errors the stream instead of skipping every file
          let h: FileHandle
          try {
            // Resolve the parent only: the last component is opened O_NOFOLLOW, so a swapped-in symlink fails (ELOOP).
            const parentRel = path.posix.dirname(e.rel)
            const parent = await resolveMidPath(name, parentRel === "." ? "" : parentRel)
            h = (await openFile(path.join(parent, path.posix.basename(e.rel)), "r", readCheck(c))).h
          } catch (err) {
            if ((err instanceof MidError && SKIP_CODES.has(err.code)) || SKIP_ERRNO.has((err as NodeJS.ErrnoException).code ?? "")) return null
            throw err
          }
          const rs = e.size > 0 ? h.createReadStream({ start: 0, end: e.size - 1, autoClose: false, emitClose: false }) : null
          return {
            stream: rs ?? (async function* (): AsyncGenerator<Uint8Array> {})(),
            close: async () => {
              rs?.destroy()
              await h.close()
            },
          }
        },
      }
    }
  }
  return zipStream(sources())
}
