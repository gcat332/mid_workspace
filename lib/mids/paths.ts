import fs from "node:fs/promises"
import path from "node:path"
import { MidError, midRoot, validateMidName } from "./names"

const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

/** Realpath of the deepest ancestor of `p` that exists (p itself included). */
async function realpathNearest(p: string): Promise<string> {
  let cur = p
  for (;;) {
    try {
      return await fs.realpath(cur)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e
      const parent = path.dirname(cur)
      if (parent === cur) throw e
      cur = parent
    }
  }
}

/**
 * Resolve `rel` inside MID `name`'s root. Never returns a path whose real location is outside the root.
 * Returns the lexical join so not-yet-existing targets work.
 */
export async function resolveMidPath(name: string, rel: string): Promise<string> {
  validateMidName(name)
  const root = midRoot(name)
  if (rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw new MidError("path_outside")
  }
  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MidError("not_found")
    throw e
  }
  const target = path.join(root, rel)
  if (!isInside(realRoot, await realpathNearest(target))) throw new MidError("path_outside")
  return target
}

export function isReadOnlyPath(name: string, absPath: string): boolean {
  const agent = path.join(midRoot(name), "agent")
  // PROVISIONAL: confirm in spike (docs/spike-mid-linux.md)
  const dirs = ["bin", "lib", "jre"].map((d) => path.join(agent, d))
  const p = path.resolve(absPath)
  return dirs.some((d) => p === d || p.startsWith(d + path.sep))
}
