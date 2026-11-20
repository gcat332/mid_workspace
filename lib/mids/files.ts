import fs from "node:fs"
import { randomBytes } from "node:crypto"
import { sha256 } from "@/lib/hash"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { CONFIG_XML, LOG_FILES, PROTECTED_DIRS, PROTECTED_SCRIPT_DIR, PROTECTED_TREES, WRAPPER_OVERRIDE } from "./layout"
import { MidError } from "./names"
import { getMid } from "./registry"
import { isReadOnlyPath, PROGRAM_DIRS, resolveMidPath } from "./paths"
import { createFileIn, fdPath, lstatIn, mapFsErrors, mkdirIn, openDir, openFile, openFileIn, readAll, removeIn, renameIn, type Check } from "./safe-fs"

export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 52,428,800

const READ_ONLY_MSG = "โฟลเดอร์นี้เป็นโปรแกรมของ MID (agent/bin, agent/lib, agent/jre) แก้ไขไม่ได้ — ถ้าจะเพิ่ม library ให้อัปโหลดที่ agent/extlib แทน"
const TOO_BIG_TEXT = "ไฟล์ใหญ่เกิน 2 MB เปิดแก้ในหน้าเว็บไม่ได้ ให้ดาวน์โหลดแทน"
const roErr = () => new MidError("read_only", 403, READ_ONLY_MSG)
const cfgErr = () => new MidError("use_config_tab")
const protErr = (msg?: string) => new MidError("protected", 403, msg)

/** Test seam: runs after paths are resolved and checked, right before the first I/O. */
export const hooks: { beforeIo?: () => void | Promise<void> } = {}
const beforeIo = async () => { await hooks.beforeIo?.() }

export type FileEntry = {
  name: string; type: "file" | "dir"; size: number; mtime: string
  /** Not editable (program dir, managed config file, symlink). */
  readOnly: boolean
  /** The entry is a symlink (rename/delete act on the link itself). */
  symlink: boolean
  /** Server always refuses rename/delete (program dir, config file, protected system/config path, or a folder containing one). */
  locked: boolean
  /** Contents are never served here (config.xml: use the config tab). */
  secret: boolean
  /** A managed config file (config.xml, wrapper-override.conf): edited in the config tab. */
  config: boolean
}

const inside = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + path.sep)

type Ctx = {
  name: string; root: string; roDirs: string[]; configFiles: string[]; configXml: string[]
  protTrees: string[]; protDirs: string[]; scriptDirs: string[]
}

async function ctxFor(name: string): Promise<Ctx> {
  await getMid(name) // unknown/removed -> 404
  const root = await resolveMidPath(name, "")
  const both = async (rel: string): Promise<string[]> => [
    await resolveMidPath(name, rel),
    path.join(await resolveMidPath(name, path.posix.dirname(rel)), path.posix.basename(rel)),
  ]
  const configXml = await both(CONFIG_XML)
  const configFiles = [...configXml, ...(await both(WRAPPER_OVERRIDE))]
  // Program dirs both lexically and through any symlinked `agent` / `bin` (resolved once).
  const roDirs = new Set<string>()
  for (const d of PROGRAM_DIRS) {
    roDirs.add(path.join(root, "agent", d))
    roDirs.add(await resolveMidPath(name, `agent/${d}`))
  }
  const protTrees = new Set<string>(), protDirs = new Set<string>()
  // A symlinked-outside or dangling entry makes resolveMidPath throw; keep whichever variants still resolve
  // (an entry relocated outside the MID is unreachable through the sandbox anyway).
  const bothSafe = async (rel: string): Promise<string[]> => {
    const out: string[] = []
    try { out.push(await resolveMidPath(name, rel)) } catch { /* unresolvable */ }
    try { out.push(path.join(await resolveMidPath(name, path.posix.dirname(rel)), path.posix.basename(rel))) } catch { /* unresolvable */ }
    return out
  }
  for (const t of PROTECTED_TREES) for (const x of await bothSafe(t)) protTrees.add(x)
  for (const t of PROTECTED_DIRS) for (const x of await bothSafe(t)) protDirs.add(x)
  const scriptDirs = await bothSafe(PROTECTED_SCRIPT_DIR)
  return { name, root, roDirs: [...roDirs], configFiles, configXml, protTrees: [...protTrees], protDirs: [...protDirs], scriptDirs }
}

const isRo = (c: Ctx, abs: string): boolean => isReadOnlyPath(c.name, abs) || c.roDirs.some((d) => inside(d, abs))

function assertWritable(c: Ctx, abs: string): void {
  if (isRo(c, abs)) throw roErr()
  if (c.configFiles.includes(abs)) throw cfgErr()
}
/** Entry must not be the root nor contain a program dir / managed config file. */
function isContainer(c: Ctx, abs: string): boolean {
  return abs === c.root || c.roDirs.some((d) => inside(abs, d)) || c.configFiles.some((f) => inside(abs, f)) ||
    c.protTrees.some((d) => inside(abs, d)) || c.protDirs.some((d) => inside(abs, d))
}
/** True inside a level-1 tree (incl. the folder itself): nothing there can be renamed, deleted or moved. */
function inProtectedTree(c: Ctx, abs: string): boolean {
  return c.protTrees.some((d) => inside(d, abs))
}
/** System/config entries that must stay where they are (viewing and editing content stay allowed). */
function isProtected(c: Ctx, abs: string): boolean {
  return inProtectedTree(c, abs) || c.protDirs.includes(abs) ||
    (abs.endsWith(".sh") && c.scriptDirs.includes(path.dirname(abs)))
}
function assertNotContainer(c: Ctx, abs: string): void {
  if (abs === c.root || c.roDirs.some((d) => inside(abs, d))) throw roErr()
  if (c.configFiles.some((f) => inside(abs, f))) throw cfgErr()
  // Strict containers only: the protected entries themselves are handled by isProtected (after the target's read_only check).
  if ([...c.protTrees, ...c.protDirs].some((d) => d !== abs && inside(abs, d))) throw protErr()
}

/** Checks applied to the REAL location of every opened handle. */
const readCheck = (c: Ctx): Check => (real) => {
  if (!inside(c.root, real)) throw new MidError("path_outside")
  if (c.configXml.includes(real)) throw cfgErr() // config.xml holds credentials the config tab masks
}
const writeCheck = (c: Ctx): Check => (real) => {
  if (!inside(c.root, real)) throw new MidError("path_outside")
  assertWritable(c, real)
}

function plainName(n: unknown): string {
  if (typeof n !== "string" || n === "" || n === "." || n === ".." || /[\\/\0]/.test(n) || Buffer.byteLength(n) > 255) {
    throw new MidError("invalid_filename")
  }
  return n
}

const mapped = mapFsErrors

async function statDirOf(abs: string): Promise<void> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MidError("not_found")
    throw e
  }
  if (!st.isDirectory()) throw new MidError("invalid_request")
}

async function entryOf(c: Ctx, rel: string): Promise<{ parent: string; base: string; abs: string }> {
  const trimmed = typeof rel === "string" ? rel.replace(/\/+$/, "") : rel
  if (typeof trimmed !== "string" || trimmed === "" || trimmed === ".") throw roErr() // the MID root itself
  const base = path.posix.basename(trimmed)
  plainName(base)
  const parentRel = path.posix.dirname(trimmed)
  const parent = await resolveMidPath(c.name, parentRel === "." ? "" : parentRel)
  return { parent, base, abs: path.join(parent, base) }
}

export function listDir(name: string, rel: string): Promise<FileEntry[]> {
  return mapped(async () => {
    const c = await ctxFor(name)
    const dir = await resolveMidPath(name, rel)
    await statDirOf(dir)
    await beforeIo()
    const d = await openDir(dir, readCheck(c))
    const out: FileEntry[] = []
    try {
      for (const n of await fs.promises.readdir(fdPath(d))) {
        const abs = path.join(dir, n)
        try {
          const l = await fs.promises.lstat(fdPath(d, n))
          let st = l
          const symlink = l.isSymbolicLink()
          let readOnly = isRo(c, abs) || c.configFiles.includes(abs)
          if (symlink) {
            // Metadata only: the target is resolved then stat'ed by path, so a racing swap can leak size/mtime/type
            // of an in-sandbox-checked name at worst; contents are never read here.
            // Shown only when the link stays inside this MID; never editable through the link.
            const target = await resolveMidPath(name, path.posix.join(rel.replace(/\\/g, "/"), n))
            st = await fs.promises.stat(target)
            readOnly = true
          }
          const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : null
          if (!type) continue
          out.push({
            name: n, type, size: type === "dir" ? 0 : st.size, mtime: st.mtime.toISOString(), readOnly, symlink,
            locked: (!symlink && (readOnly || isContainer(c, abs))) || isProtected(c, abs),
            secret: c.configXml.includes(abs),
            config: !symlink && c.configFiles.includes(abs),
          })
        } catch (e) {
          if (e instanceof MidError && e.code === "path_outside") continue
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue // vanished or dangling
          throw e
        }
      }
    } finally {
      await d.close()
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
  })
}

/** Is the directory `rel` read-only here (a program dir or inside one)? The UI disables upload/new folder there. */
export function dirReadOnly(name: string, rel: string): Promise<boolean> {
  return mapped(async () => {
    const c = await ctxFor(name)
    return isRo(c, await resolveMidPath(name, rel))
  })
}

export function readText(name: string, rel: string): Promise<{ content: string; hash: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    const abs = await resolveMidPath(name, rel)
    readCheck(c)(abs)
    await beforeIo()
    const { h, st } = await openFile(abs, "r", readCheck(c))
    try {
      if (st.size > MAX_TEXT_BYTES) throw new MidError("too_large", 413, TOO_BIG_TEXT)
      const buf = await readAll(h, MAX_TEXT_BYTES + 1)
      if (buf.length > MAX_TEXT_BYTES) throw new MidError("too_large", 413, TOO_BIG_TEXT)
      if (buf.subarray(0, 8192).includes(0)) throw new MidError("not_text")
      return { content: buf.toString("utf8"), hash: sha256(buf) }
    } finally {
      await h.close()
    }
  })
}

/** `baseHash: ""` creates a new file (O_EXCL; an existing one is `exists` 409), otherwise edits in place with stale detection. */
export function writeText(name: string, rel: string, content: string, baseHash: string): Promise<{ hash: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    const abs = await resolveMidPath(name, rel)
    assertWritable(c, abs)
    const data = Buffer.from(content, "utf8")
    if (data.length > MAX_TEXT_BYTES) throw new MidError("too_large", 413, TOO_BIG_TEXT)
    if (baseHash === "") return createText(c, rel, data)
    await beforeIo()
    // In place so owner, group and mode are preserved; truncation happens only after all checks.
    const { h, st } = await openFile(abs, "rw", writeCheck(c))
    try {
      if (st.size > MAX_TEXT_BYTES) throw new MidError("too_large", 413, TOO_BIG_TEXT)
      const cur = await readAll(h, st.size)
      if (sha256(cur) !== baseHash) throw new MidError("stale")
      await h.truncate(0)
      await h.write(data, 0, data.length, 0)
    } finally {
      await h.close()
    }
    return { hash: sha256(data) }
  })
}

async function createText(c: Ctx, rel: string, data: Buffer): Promise<{ hash: string }> {
  const e = await entryOf(c, rel)
  await statDirOf(e.parent)
  assertWritable(c, e.parent)
  assertWritable(c, e.abs)
  await beforeIo()
  const wc = writeCheck(c)
  const d = await openDir(e.parent, wc)
  try {
    let h: FileHandle
    try {
      h = await createFileIn(d, e.parent, e.base, wc)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new MidError("exists") // read it, then edit with its hash
      throw err
    }
    try {
      await h.write(data, 0, data.length, 0)
    } finally {
      await h.close()
    }
  } finally {
    await d.close()
  }
  return { hash: sha256(data) }
}

export function upload(name: string, dirRel: string, filename: string, data: Buffer): Promise<{ size: number; path: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    plainName(filename)
    if (data.length > MAX_UPLOAD_BYTES) throw new MidError("too_large")
    const dir = await resolveMidPath(name, dirRel)
    await statDirOf(dir)
    assertWritable(c, dir)
    assertWritable(c, path.join(dir, filename))
    await beforeIo()
    const wc = writeCheck(c)
    const d = await openDir(dir, wc)
    try {
      let h: FileHandle
      try {
        h = (await openFileIn(d, dir, filename, wc)).h // replace in place, keep owner/group
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ELOOP" || code === "EISDIR") throw new MidError("conflict") // symlink/dir: never write through/over
        if (code !== "ENOENT") throw e
        h = await createFileIn(d, dir, filename, wc)
      }
      try {
        await h.truncate(0)
        await h.write(data, 0, data.length, 0)
      } finally {
        await h.close()
      }
    } finally {
      await d.close()
    }
    return { size: data.length, path: path.relative(c.root, path.join(dir, filename)) }
  })
}

const UPLOAD_TMP_RE = /^\.midhub-upload-[0-9a-f]{16}\.part$/
const STALE_TMP_MS = 60 * 60 * 1000

/** Best effort: drop upload temp files of crashed/killed uploads (regular files, > 1 h old) in this verified dir. */
async function sweepStaleTemps(d: FileHandle): Promise<void> {
  try {
    const cutoff = Date.now() - STALE_TMP_MS
    for (const n of await fs.promises.readdir(fdPath(d))) {
      if (!UPLOAD_TMP_RE.test(n)) continue
      const st = await lstatIn(d, n).catch(() => null)
      // unlink through the dir fd never follows the last component
      if (st?.isFile() && st.mtimeMs < cutoff) await fs.promises.unlink(fdPath(d, n)).catch(() => {})
    }
  } catch { /* cleanup only */ }
}

const LENGTH_REQUIRED_MSG = "อัปโหลดต้องส่ง Content-Length เป็นจำนวนไบต์ของไฟล์ (เช่น curl --data-binary @ไฟล์) แล้วลองใหม่"
const LENGTH_MISMATCH_MSG = "ข้อมูลที่ส่งมาไม่ตรงกับ Content-Length (ส่งไม่ครบหรือเกิน) ไฟล์จึงไม่ถูกบันทึก ส่งไฟล์ใหม่อีกครั้ง"

/**
 * Raw-body upload (AgentHub). Same rules for the final name as upload(), but the body is streamed into a temp file
 * `.midhub-upload-<random>.part` created O_EXCL in the verified target dir, counted against `declaredLength` (and the
 * 50 MiB cap) as it arrives, and renamed over the final name through the dir fd only when exactly `declaredLength`
 * bytes arrived. Any failure removes the temp file; an existing file is replaced atomically or left untouched.
 * The length checks run before anything else, so an oversized/unsized request never has its body read.
 */
export function uploadStream(
  name: string, dirRel: string, filename: string, body: ReadableStream<Uint8Array> | null, declaredLength: number,
): Promise<{ size: number; path: string }> {
  return mapped(async () => {
    if (!Number.isInteger(declaredLength) || declaredLength < 0) throw new MidError("length_required", 411, LENGTH_REQUIRED_MSG)
    if (declaredLength > MAX_UPLOAD_BYTES) throw new MidError("too_large")
    const c = await ctxFor(name)
    plainName(filename)
    const dir = await resolveMidPath(name, dirRel)
    await statDirOf(dir)
    assertWritable(c, dir)
    assertWritable(c, path.join(dir, filename))
    await beforeIo()
    const wc = writeCheck(c)
    const d = await openDir(dir, wc)
    try {
      await sweepStaleTemps(d)
      // Final name: exactly upload()'s overwrite rules (never a symlink/dir, regular file with nlink 1, real path checked).
      // A replaced file keeps its permission bits (not its owner: the new inode belongs to the app user).
      let keepMode: number | null = null
      try {
        const old = await openFileIn(d, dir, filename, wc)
        keepMode = old.st.mode & 0o777
        await old.h.close()
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ELOOP" || code === "EISDIR") throw new MidError("conflict")
        if (code !== "ENOENT") throw e
      }
      const tmp = `.midhub-upload-${randomBytes(8).toString("hex")}.part` // matches UPLOAD_TMP_RE
      const h = await createFileIn(d, dir, tmp, wc)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let n = 0
      try {
        try {
          reader = body?.getReader()
          for (;;) {
            if (!reader) break
            const { done, value } = await reader.read()
            if (done) break
            n += value.byteLength
            if (n > declaredLength || n > MAX_UPLOAD_BYTES) throw new MidError("invalid_request", 400, LENGTH_MISMATCH_MSG)
            let off = 0
            while (off < value.byteLength) off += (await h.write(value, off, value.byteLength - off)).bytesWritten
          }
          if (n !== declaredLength) throw new MidError("invalid_request", 400, LENGTH_MISMATCH_MSG)
          if (keepMode !== null) await h.chmod(keepMode) // fchmod on the temp fd
        } finally {
          await h.close()
        }
        await renameIn(d, tmp, filename)
      } catch (e) {
        await reader?.cancel().catch(() => {})
        await fs.promises.unlink(fdPath(d, tmp)).catch(() => {})
        throw e
      }
    } finally {
      await d.close()
    }
    return { size: declaredLength, path: path.relative(c.root, path.join(dir, filename)) }
  })
}

export function mkdir(name: string, parentRel: string, dirName: string): Promise<{ path: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    plainName(dirName)
    const parent = await resolveMidPath(name, parentRel)
    await statDirOf(parent)
    assertWritable(c, parent)
    assertWritable(c, path.join(parent, dirName))
    await beforeIo()
    const wc = writeCheck(c)
    const d = await openDir(parent, wc)
    try {
      if (await lstatIn(d, dirName)) throw new MidError("conflict")
      await mkdirIn(d, parent, dirName, wc)
    } finally {
      await d.close()
    }
    return { path: path.relative(c.root, path.join(parent, dirName)) }
  })
}

/** Acts on the entry itself (never a symlink's target) and only within its own parent. */
export function rename(name: string, rel: string, newName: string): Promise<{ to: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    plainName(newName)
    const e = await entryOf(c, rel)
    assertWritable(c, e.abs)
    assertNotContainer(c, e.abs)
    assertWritable(c, path.join(e.parent, newName)) // e.g. renaming onto a program dir name
    if (isProtected(c, e.abs) || isProtected(c, path.join(e.parent, newName))) throw protErr()
    await beforeIo()
    const d = await openDir(e.parent, writeCheck(c))
    try {
      if (!(await lstatIn(d, e.base))) throw new MidError("not_found")
      if (await lstatIn(d, newName)) throw new MidError("conflict")
      await renameIn(d, e.base, newName)
    } finally {
      await d.close()
    }
    return { to: path.relative(c.root, path.join(e.parent, newName)) }
  })
}

/** Removing a symlink removes the link only; directories are walked fd-by-fd (links inside are unlinked, not followed). */
export function remove(name: string, rel: string): Promise<{ path: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    const e = await entryOf(c, rel)
    assertWritable(c, e.abs)
    if (isProtected(c, e.abs)) throw protErr()
    const st = await fs.promises.lstat(e.abs).catch(() => null)
    if (!st) throw new MidError("not_found")
    if (!st.isSymbolicLink()) assertNotContainer(c, e.abs)
    await beforeIo()
    const wc = writeCheck(c)
    const d = await openDir(e.parent, wc)
    try {
      await removeIn(d, e.parent, e.base, wc)
    } finally {
      await d.close()
    }
    return { path: path.relative(c.root, e.abs) }
  })
}

/** Verified, open handle for streaming; `size` is the byte count to send (later growth is not sent). Caller closes via the stream. */
export function openDownload(name: string, rel: string): Promise<{ handle: FileHandle; size: number; filename: string }> {
  return mapped(async () => {
    const c = await ctxFor(name)
    const abs = await resolveMidPath(name, rel)
    readCheck(c)(abs)
    await beforeIo()
    const { h, st } = await openFile(abs, "r", readCheck(c))
    return { handle: h, size: st.size, filename: path.basename(rel.replace(/\/+$/, "")) || path.basename(abs) }
  })
}

export type LogKey = keyof typeof LOG_FILES
export const isLogKey = (k: unknown): k is LogKey => typeof k === "string" && Object.hasOwn(LOG_FILES, k)

/**
 * Opener for tailFile: every call re-resolves the log path and returns a freshly verified fd
 * (O_NOFOLLOW + /proc/self/fd check), so rotation or a symlink swap is detected without ever reading by path.
 */
export async function openLog(name: string, key: LogKey): Promise<() => Promise<{ h: FileHandle; st: fs.Stats }>> {
  const c = await mapped(() => ctxFor(name))
  return () => mapped(async () => {
    const abs = await resolveMidPath(name, LOG_FILES[key])
    readCheck(c)(abs)
    return openFile(abs, "r", readCheck(c))
  })
}
