import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { CONFIG_XML, WRAPPER_OVERRIDE } from "./layout"
import { MidError } from "./names"
import { getMid } from "./registry"
import { isReadOnlyPath, resolveMidPath } from "./paths"

export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 52,428,800

const READ_ONLY_MSG = "โฟลเดอร์นี้เป็นโปรแกรมของ MID แก้ไขไม่ได้"
const TOO_BIG_TEXT = "ไฟล์ใหญ่เกิน 2 MB เปิดแก้ในหน้าเว็บไม่ได้ ให้ดาวน์โหลดแทน"
const roErr = () => new MidError("read_only", 403, READ_ONLY_MSG)
const cfgErr = () => new MidError("use_config_tab")

export type FileEntry = { name: string; type: "file" | "dir"; size: number; mtime: string; readOnly: boolean }

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")
const inside = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + path.sep)

/** Everything the guards need about one MID, resolved once per operation. */
type Ctx = { name: string; root: string; roDirs: string[]; configFiles: string[] }

async function ctxFor(name: string): Promise<Ctx> {
  await getMid(name) // unknown/removed -> 404
  const root = await resolveMidPath(name, "")
  const configFiles = new Set<string>()
  for (const rel of [CONFIG_XML, WRAPPER_OVERRIDE]) {
    // The file's own (possibly symlink-resolved) location and its location under the real parent.
    configFiles.add(await resolveMidPath(name, rel))
    configFiles.add(path.join(await resolveMidPath(name, path.posix.dirname(rel)), path.posix.basename(rel)))
  }
  return { name, root, roDirs: ["bin", "lib", "jre"].map((d) => path.join(root, "agent", d)), configFiles: [...configFiles] }
}

/** Plain single path component: no separators, NUL, `.`/`..`, empty, or > 255 bytes. */
function plainName(n: unknown): string {
  if (typeof n !== "string" || n === "" || n === "." || n === ".." || /[\\/\0]/.test(n) || Buffer.byteLength(n) > 255) {
    throw new MidError("invalid_request")
  }
  return n
}

/** Refuse a write that lands on/in a program folder or on a managed config file. */
function assertWritable(c: Ctx, abs: string): void {
  if (isReadOnlyPath(c.name, abs)) throw roErr()
  if (c.configFiles.includes(abs)) throw cfgErr()
}

/** Extra rule for remove/rename: the entry must not be the root or contain a program dir / managed config file. */
function assertNotContainer(c: Ctx, abs: string): void {
  if (abs === c.root || c.roDirs.some((d) => inside(abs, d))) throw roErr()
  if (c.configFiles.some((f) => inside(abs, f))) throw cfgErr()
}

async function regularFile(abs: string): Promise<fs.Stats> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MidError("not_found")
    throw e
  }
  if (!st.isFile()) throw new MidError("invalid_request")
  return st
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

/** Split a MID-relative path into the real parent directory and the entry's own name. */
async function entryOf(c: Ctx, rel: string): Promise<{ parent: string; base: string; abs: string }> {
  const trimmed = typeof rel === "string" ? rel.replace(/\/+$/, "") : rel
  if (typeof trimmed !== "string" || trimmed === "" || trimmed === ".") throw roErr() // the MID root itself
  const base = path.posix.basename(trimmed)
  plainName(base)
  const parent = await resolveMidPath(c.name, path.posix.dirname(trimmed) === "." ? "" : path.posix.dirname(trimmed))
  return { parent, base, abs: path.join(parent, base) }
}

export async function listDir(name: string, rel: string): Promise<FileEntry[]> {
  const c = await ctxFor(name)
  const dir = await resolveMidPath(name, rel)
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") throw new MidError("not_found")
    if (code === "ENOTDIR") throw new MidError("invalid_request")
    throw e
  }
  const out: FileEntry[] = []
  for (const n of names) {
    const abs = path.join(dir, n)
    try {
      const l = await fs.promises.lstat(abs)
      let st = l
      let readOnly = isReadOnlyPath(name, abs) || c.configFiles.includes(abs)
      if (l.isSymbolicLink()) {
        // Shown only when the link stays inside this MID; never editable through the link.
        await resolveMidPath(name, path.posix.join(rel.replace(/\\/g, "/"), n))
        st = await fs.promises.stat(abs)
        readOnly = true
      }
      const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : null
      if (type) out.push({ name: n, type, size: type === "dir" ? 0 : st.size, mtime: st.mtime.toISOString(), readOnly })
    } catch (e) {
      if (e instanceof MidError && e.code === "path_outside") continue
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue // vanished or dangling
      throw e
    }
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
}

export async function readText(name: string, rel: string): Promise<{ content: string; hash: string }> {
  const c = await ctxFor(name)
  const abs = await resolveMidPath(name, rel)
  // config.xml holds credentials that the config tab masks; do not hand them out raw here.
  if (c.configFiles.includes(abs) && abs.endsWith(path.sep + "config.xml")) throw cfgErr()
  const st = await regularFile(abs)
  if (st.size > MAX_TEXT_BYTES) throw new MidError("too_large", 413, TOO_BIG_TEXT)
  const buf = await fs.promises.readFile(abs)
  if (buf.subarray(0, 8192).includes(0)) throw new MidError("not_text")
  return { content: buf.toString("utf8"), hash: sha256(buf) }
}

export async function writeText(name: string, rel: string, content: string, baseHash: string): Promise<{ hash: string }> {
  const c = await ctxFor(name)
  const abs = await resolveMidPath(name, rel)
  assertWritable(c, abs)
  const data = Buffer.from(content, "utf8")
  if (data.length > MAX_TEXT_BYTES) throw new MidError("too_large", 413, TOO_BIG_TEXT)
  await regularFile(abs)
  // In place (r+ then truncate) so owner, group and mode of the file are preserved.
  const fh = await fs.promises.open(abs, "r+")
  try {
    const cur = await fh.readFile()
    if (sha256(cur) !== baseHash) throw new MidError("stale")
    await fh.truncate(0)
    await fh.write(data, 0, data.length, 0)
  } finally {
    await fh.close()
  }
  return { hash: sha256(data) }
}

export async function upload(name: string, dirRel: string, filename: string, data: Buffer): Promise<{ size: number }> {
  const c = await ctxFor(name)
  plainName(filename)
  if (data.length > MAX_UPLOAD_BYTES) throw new MidError("too_large")
  const dir = await resolveMidPath(name, dirRel)
  const dst = await fs.promises.stat(dir).catch(() => null)
  if (!dst) throw new MidError("not_found")
  if (!dst.isDirectory()) throw new MidError("invalid_request")
  const abs = path.join(dir, filename)
  assertWritable(c, dir)
  assertWritable(c, abs)
  const existing = await lstatOrNull(abs)
  if (existing && !existing.isFile()) throw new MidError("conflict") // dir or symlink: never write through/over
  if (existing) {
    const fh = await fs.promises.open(abs, "r+") // replace in place, keep owner/group
    try {
      await fh.truncate(0)
      await fh.write(data, 0, data.length, 0)
    } finally {
      await fh.close()
    }
  } else {
    const fh = await fs.promises.open(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o664)
    try {
      await fh.chmod(0o664) // umask may have stripped group write
      await fh.write(data, 0, data.length, 0)
    } finally {
      await fh.close()
    }
  }
  return { size: data.length }
}

export async function mkdir(name: string, parentRel: string, dirName: string): Promise<void> {
  const c = await ctxFor(name)
  plainName(dirName)
  const parent = await resolveMidPath(name, parentRel)
  const st = await fs.promises.stat(parent).catch(() => null)
  if (!st) throw new MidError("not_found")
  if (!st.isDirectory()) throw new MidError("invalid_request")
  const abs = path.join(parent, dirName)
  assertWritable(c, parent)
  assertWritable(c, abs)
  if (await lstatOrNull(abs)) throw new MidError("conflict")
  await fs.promises.mkdir(abs, { mode: 0o775 })
  await fs.promises.chmod(abs, 0o775)
}

/** Acts on the entry itself (never a symlink's target) and only within its own parent. */
export async function rename(name: string, rel: string, newName: string): Promise<{ to: string }> {
  const c = await ctxFor(name)
  plainName(newName)
  const e = await entryOf(c, rel)
  assertWritable(c, e.abs)
  assertNotContainer(c, e.abs)
  const target = path.join(e.parent, newName)
  assertWritable(c, target)
  if (!(await lstatOrNull(e.abs))) throw new MidError("not_found")
  if (await lstatOrNull(target)) throw new MidError("conflict")
  await fs.promises.rename(e.abs, target)
  const parentRel = path.posix.dirname(rel.replace(/\/+$/, ""))
  return { to: path.posix.join(parentRel === "." ? "" : parentRel, newName) }
}

/** Removing a symlink removes the link only; directories are removed recursively (links inside are not followed). */
export async function remove(name: string, rel: string): Promise<void> {
  const c = await ctxFor(name)
  const e = await entryOf(c, rel)
  assertWritable(c, e.abs)
  assertNotContainer(c, e.abs)
  const st = await lstatOrNull(e.abs)
  if (!st) throw new MidError("not_found")
  if (st.isDirectory()) await fs.promises.rm(e.abs, { recursive: true })
  else await fs.promises.unlink(e.abs)
}

/** Validates a download target; the route streams `path`. */
export async function downloadInfo(name: string, rel: string): Promise<{ path: string; size: number; filename: string }> {
  const c = await ctxFor(name)
  const abs = await resolveMidPath(name, rel)
  if (c.configFiles.includes(abs) && abs.endsWith(path.sep + "config.xml")) throw cfgErr()
  const st = await regularFile(abs)
  return { path: abs, size: st.size, filename: path.basename(abs) }
}
