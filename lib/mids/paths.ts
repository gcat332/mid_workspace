import fs from "node:fs"
import path from "node:path"
import { MidError, midRoot, validateMidName } from "./names"

const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

/**
 * Resolve the deepest existing ancestor of `target` through symlinks and re-attach the
 * not-yet-existing tail. A component that exists as a symlink but cannot be resolved
 * (dangling, loop) is rejected: a later write through it would land at an unchecked place.
 */
async function realpathWithTail(target: string): Promise<string> {
  const tail: string[] = []
  let cur = target
  for (;;) {
    try {
      await fs.promises.lstat(cur)
      let real: string
      try {
        real = await fs.promises.realpath(cur)
      } catch {
        throw new MidError("path_outside")
      }
      return path.join(real, ...tail.reverse())
    } catch (e) {
      if (e instanceof MidError) throw e
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOTDIR" || code === "ELOOP") throw new MidError("path_outside")
      if (code !== "ENOENT") throw e
      const parent = path.dirname(cur)
      if (parent === cur) throw e
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * Resolve `rel` inside MID `name`'s root and return the resolved real path (symlinks followed;
 * only segments that do not exist yet are appended lexically). Throws path_outside if the real
 * location is outside the root.
 */
export async function resolveMidPath(name: string, rel: string): Promise<string> {
  validateMidName(name)
  if (typeof rel !== "string" || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw new MidError("path_outside")
  }
  const root = midRoot(name)
  let realRoot: string
  try {
    realRoot = await fs.promises.realpath(root)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MidError("not_found")
    throw e
  }
  // Join onto the real root so a symlinked midhubRoot behaves the same as a plain one.
  const resolved = await realpathWithTail(path.join(realRoot, rel))
  if (!isInside(realRoot, resolved)) throw new MidError("path_outside")
  return resolved
}

// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
/** Read-only program dirs under `<mid root>/agent`. Single source of truth (also used by files.ts). */
export const PROGRAM_DIRS = ["bin", "lib", "jre"] as const

/** `absPath` must be a path returned by resolveMidPath (real, link-free). */
export function isReadOnlyPath(name: string, absPath: string): boolean {
  if (!path.isAbsolute(absPath)) throw new MidError("path_outside")
  let root = midRoot(name)
  try {
    root = fs.realpathSync(root)
  } catch {
    // root missing: fall back to the lexical root
  }
  const dirs = PROGRAM_DIRS.map((d) => path.join(root, "agent", d))
  const p = path.resolve(absPath)
  return dirs.some((d) => p === d || p.startsWith(d + path.sep))
}
