// fd-anchored file primitives. Every handle is opened with O_NOFOLLOW and then verified through
// /proc/self/fd, so the check applies to the object that is actually used (not to a name that a
// concurrent writer, e.g. the MID process, could re-point between check and use).
//
// Assumption: reads (not writes) of a hardlinked file are not nlink-checked; this relies on the kernel's
// fs.protected_hardlinks=1 (default) so midsvc cannot hardlink files it does not own into the tree.
// Residual races that are inherent in Node/POSIX and NOT closed here:
//  - rename() has no RENAME_NOREPLACE: a target created between our exists-check and the rename is overwritten.
//  - Writes through openFile/openFileIn are in place and not atomic (readers may see a partial file); provision's
//    atomicWrite (mid-files.ts) writes a temp file in the same verified dir and renames it instead.
//  - A name inside a verified directory can still be swapped by midsvc between our lstat and our
//    unlink/rmdir; the effect is confined to that (verified, in-sandbox, writable) directory.
import fs from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { MidError } from "./names"

const C = fs.constants
export type Check = (real: string) => void

/** Maps fs errors to MidErrors (anything unexpected is rethrown as is). */
export function translateFsError(e: unknown): never {
  const code = (e as NodeJS.ErrnoException)?.code
  switch (code) {
    case "ENOENT": throw new MidError("not_found")
    case "ENXIO": throw new MidError("invalid_request") // FIFO/device opened non-blocking
    case "ELOOP": case "ENOTDIR": throw new MidError("path_outside")
    case "EACCES": case "EPERM": throw new MidError("no_permission")
    case "EEXIST": case "EISDIR": case "ENOTEMPTY": throw new MidError("conflict")
    case "ENOSPC": throw new MidError("disk_full")
    default: throw e
  }
}
export async function mapFsErrors<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    return translateFsError(e)
  }
}

/** Reads at most `limit` bytes from the start of the handle. */
export async function readAll(h: FileHandle, limit: number): Promise<Buffer> {
  const buf = Buffer.alloc(limit)
  let n = 0
  while (n < limit) {
    const { bytesRead } = await h.read(buf, n, limit - n, n)
    if (bytesRead === 0) break
    n += bytesRead
  }
  return buf.subarray(0, n)
}

/** Check for a file whose real location must be inside `root` (exact location is enforced by openFile). */
export const insideCheck = (root: string): Check => (real) => {
  if (real !== root && !real.startsWith(root + path.sep)) throw new MidError("path_outside")
}

/** Whole regular file read through a verified fd; too_large (413) above `limit` bytes. Raw fs errors propagate. */
export async function readFileVerified(abs: string, check: Check, limit: number): Promise<Buffer> {
  const { h, st } = await openFile(abs, "r", check)
  try {
    if (st.size > limit) throw new MidError("too_large", 413, `ไฟล์ใหญ่เกิน ${Math.round(limit / 1024 / 1024)} MB`)
    const buf = await readAll(h, limit + 1)
    if (buf.length > limit) throw new MidError("too_large", 413, `ไฟล์ใหญ่เกิน ${Math.round(limit / 1024 / 1024)} MB`)
    return buf
  } finally {
    await h.close()
  }
}

export const fdPath = (h: FileHandle, name?: string): string => `/proc/self/fd/${h.fd}${name ? "/" + name : ""}`

/** The handle's real location must be exactly `expected` (when given) and pass `check`. */
async function verify(h: FileHandle, expected: string | undefined, check: Check): Promise<void> {
  let real: string
  try {
    real = await fs.promises.readlink(fdPath(h)) // kernel d_path: canonical, no symlinks
  } catch {
    throw new MidError("path_outside")
  }
  if (real.endsWith(" (deleted)")) throw new MidError("path_outside")
  if (expected !== undefined && real !== expected) throw new MidError("path_outside")
  check(real)
}

async function openVerified(p: string, flags: number, mode: number | undefined, expected: string | undefined, check: Check): Promise<FileHandle> {
  // O_NONBLOCK|O_NOCTTY: opening a FIFO/device must never block a libuv thread; the fstat type check rejects it afterwards.
  // (No effect on later reads/writes of regular files.)
  const h = await fs.promises.open(p, flags | C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY, mode)
  try {
    await verify(h, expected, check)
    return h
  } catch (e) {
    await h.close()
    throw e
  }
}

export type Opened = { h: FileHandle; st: fs.Stats }

/** Existing regular file. write=true additionally requires nlink === 1 (no hardlink to somewhere else). */
export async function openFile(abs: string, mode: "r" | "w" | "rw", check: Check, via: string = abs): Promise<Opened> {
  const flags = mode === "r" ? C.O_RDONLY : mode === "w" ? C.O_WRONLY : C.O_RDWR
  const h = await openVerified(via, flags, undefined, abs, check)
  try {
    const st = await h.stat()
    if (!st.isFile()) throw new MidError("invalid_request")
    if (mode !== "r" && st.nlink !== 1) throw new MidError("conflict", 409, "ไฟล์นี้มี hardlink จึงแก้ไขผ่านหน้าเว็บไม่ได้")
    return { h, st }
  } catch (e) {
    await h.close()
    throw e
  }
}

export async function openDir(abs: string, check: Check): Promise<FileHandle> {
  return openVerified(abs, C.O_RDONLY | C.O_DIRECTORY, undefined, abs, check)
}

/** Create a new regular file (0664) under an already verified directory handle; fails if the name exists. */
export async function createFileIn(dir: FileHandle, dirReal: string, name: string, check: Check): Promise<FileHandle> {
  const h = await openVerified(fdPath(dir, name), C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o664, path.join(dirReal, name), check)
  try {
    await h.chmod(0o664) // umask may have stripped group write
    return h
  } catch (e) {
    await h.close()
    throw e
  }
}

/** Open an existing regular file for overwrite under a verified directory handle (no truncation yet). */
export const openFileIn = (dir: FileHandle, dirReal: string, name: string, check: Check): Promise<Opened> =>
  openFile(path.join(dirReal, name), "w", check, fdPath(dir, name))

/**
 * mkdir under a verified directory handle; the new dir is chmod'ed through its own handle to 2775: setgid keeps
 * group midhub on everything created inside it later (by the MID too), so the app can keep editing it.
 */
export async function mkdirIn(dir: FileHandle, dirReal: string, name: string, check: Check): Promise<void> {
  await fs.promises.mkdir(fdPath(dir, name), { mode: 0o2775 })
  const h = await openVerified(fdPath(dir, name), C.O_RDONLY | C.O_DIRECTORY, undefined, path.join(dirReal, name), check)
  try {
    await h.chmod(0o2775)
  } finally {
    await h.close()
  }
}

export const lstatIn = async (dir: FileHandle, name: string): Promise<fs.Stats | null> => {
  try {
    return await fs.promises.lstat(fdPath(dir, name))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

export const renameIn = (dir: FileHandle, from: string, to: string): Promise<void> =>
  fs.promises.rename(fdPath(dir, from), fdPath(dir, to))

/** Recursive delete anchored per directory; symlinks are unlinked, never followed. */
async function rmTreeVerified(anchored: string, expected: string, check: Check): Promise<void> {
  const d = await openVerified(anchored, C.O_RDONLY | C.O_DIRECTORY, undefined, expected, check)
  try {
    for (const n of await fs.promises.readdir(fdPath(d))) {
      const child = fdPath(d, n)
      const st = await fs.promises.lstat(child)
      if (st.isDirectory()) {
        await rmTreeVerified(child, path.join(expected, n), check)
        await fs.promises.rmdir(child)
      } else {
        await fs.promises.unlink(child)
      }
    }
  } finally {
    await d.close()
  }
}

/** Remove the entry `name` of a verified directory: unlink for files/symlinks, own walk for directories. */
export async function removeIn(dir: FileHandle, dirReal: string, name: string, check: Check): Promise<void> {
  const st = await lstatIn(dir, name)
  if (!st) throw new MidError("not_found")
  const p = fdPath(dir, name)
  if (st.isDirectory()) {
    await rmTreeVerified(p, path.join(dirReal, name), check)
    await fs.promises.rmdir(p)
  } else {
    await fs.promises.unlink(p)
  }
}
