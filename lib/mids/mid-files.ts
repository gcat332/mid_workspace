// Shared fd-anchored helpers for files inside one MID's tree (config-service, provision). All I/O goes through
// safe-fs handles whose real path is verified against the MID root (and not a read-only program dir).
import path from "node:path"
import fs from "node:fs"
import { randomBytes } from "node:crypto"
import type { FileHandle } from "node:fs/promises"
import { MidError } from "./names"
import { isReadOnlyPath, resolveMidPath } from "./paths"
import { createFileIn, fdPath, insideCheck, openDir, readFileVerified, renameIn, translateFsError, type Check } from "./safe-fs"

export type Target = { abs: string; check: Check }

/**
 * Resolved location of `rel` in MID `name` plus the check every opened handle must pass: inside the MID root and
 * not in a program dir. The handle's real path is additionally pinned to `abs` by safe-fs.
 */
export async function target(name: string, rel: string): Promise<Target> {
  const root = await resolveMidPath(name, "")
  const abs = await resolveMidPath(name, rel)
  if (isReadOnlyPath(name, abs)) throw new MidError("read_only")
  const inside = insideCheck(root)
  return {
    abs,
    check: (real) => {
      inside(real)
      if (isReadOnlyPath(name, real)) throw new MidError("read_only")
    },
  }
}

export const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT"

/** Whole file through a verified fd; null when it does not exist. Other fs errors are translated to MidErrors. */
export async function readOpt(t: Target, limit: number): Promise<string | null> {
  try {
    return (await readFileVerified(t.abs, t.check, limit)).toString("utf8")
  } catch (e) {
    if (isEnoent(e)) return null
    return translateFsError(e)
  }
}

/** Creates the (missing) file inside its verified parent directory; fails if it appeared meanwhile. */
export async function createVerified(t: Target): Promise<FileHandle> {
  const dir = path.dirname(t.abs)
  try {
    const d = await openDir(dir, t.check)
    try {
      return await createFileIn(d, dir, path.basename(t.abs), t.check)
    } finally {
      await d.close()
    }
  } catch (e) {
    return translateFsError(e)
  }
}

/**
 * Atomic replace: `fill` writes a temp file (0664, or `mode`) created in the same verified directory, which is then
 * renamed over the target. A symlink at the target name is replaced, never followed.
 */
export async function atomicWrite(t: Target, fill: (h: FileHandle) => Promise<void>, mode = 0o664): Promise<void> {
  const dir = path.dirname(t.abs)
  const base = path.basename(t.abs)
  try {
    const d = await openDir(dir, t.check)
    try {
      const tmp = `.${base}.midhub-${randomBytes(6).toString("hex")}`
      const h = await createFileIn(d, dir, tmp, t.check)
      try {
        try {
          await fill(h)
          await h.chmod(mode)
        } finally {
          await h.close()
        }
        await renameIn(d, tmp, base)
      } catch (e) {
        await fs.promises.unlink(fdPath(d, tmp)).catch(() => {})
        throw e
      }
    } finally {
      await d.close()
    }
  } catch (e) {
    return translateFsError(e)
  }
}

export const writeFileAt = (t: Target, data: Buffer, mode?: number): Promise<void> =>
  atomicWrite(t, async (h) => void (await h.writeFile(data)), mode)
