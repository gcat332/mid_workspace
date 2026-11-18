// Safe extraction of the (untrusted) MID zip into mids/<name>. Everything under mids/ goes through safe-fs
// handles; the only path-based access is by unzip itself, which writes into a temp dir we created and verified
// (its real path is handed over), and the lstat walk afterwards rejects anything unexpected.
// Permissions: unzip honours stored modes; ownership/modes are normalised later by the helper's fixOwnership.
import { execFile } from "node:child_process"
import fs from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { createFileIn, fdPath, insideCheck, lstatIn, mkdirIn, openDir, readFileVerified, removeIn, renameIn } from "./safe-fs"
import { MidError, midRoot, validateMidName } from "./names"

const run = promisify(execFile)
// explicit env: no UNZIP/ZIPINFO leakage
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } as NodeJS.ProcessEnv
export const MAX_ENTRIES = 20000
export const MAX_UNCOMPRESSED = 2 * 1024 ** 3
const MARKER = ".midhub-installed-by"

const bad = (detail?: string): MidError => new MidError("zip_invalid", undefined, undefined, detail)

/** Pure check of `zipinfo -1` names and the `zipinfo` long listing; throws zip_invalid on the first violation. */
export function checkListing(namesOut: string, longOut: string): void {
  const names = namesOut.split("\n").filter((n) => n !== "")
  if (names.length === 0) throw bad("empty")
  if (names.length > MAX_ENTRIES) throw bad(`entries>${MAX_ENTRIES}`)
  for (const n of names) {
    if (n.includes("\0") || n.includes("\\") || n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").includes("..")) throw bad(n)
    if (!(n.startsWith("agent/") || n.startsWith("META-INF/"))) throw bad(n)
  }
  let count = 0
  let total = 0
  for (const line of longOut.split("\n")) {
    const m = /^([-dlcbps?][-rwxsStT]{9})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s(.*)$/.exec(line)
    if (!m) continue
    count++
    if (!"-d?".includes(m[1][0])) throw bad(m[3]) // symlink, device, fifo ...
    total += Number(m[2])
  }
  // A name containing a newline (or an unparsable line) would make the two listings disagree.
  if (count !== names.length) throw bad("listing mismatch")
  if (total > MAX_UNCOMPRESSED) throw bad(`uncompressed>${MAX_UNCOMPRESSED}`)
  for (const req of ["agent/bin/mid.sh", "agent/config.xml"]) if (!names.includes(req)) throw bad(`missing ${req}`)
}

async function zipinfo(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("/usr/bin/zipinfo", args, { env: ENV, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
    return stdout
  } catch (e) {
    throw bad((e as Error).message?.slice(0, 200))
  }
}

export async function validateZip(zipPath: string): Promise<void> {
  const [names, long] = await Promise.all([zipinfo(["-1", zipPath]), zipinfo([zipPath])])
  checkListing(names, long)
}

/** lstat walk of the extracted tree through verified directory handles: only regular files (nlink 1) and dirs. */
async function verifyTree(abs: string, check: (r: string) => void): Promise<void> {
  const d = await openDir(abs, check)
  try {
    for (const n of await fs.promises.readdir(fdPath(d))) {
      const st = await fs.promises.lstat(fdPath(d, n))
      if (st.isDirectory()) await verifyTree(path.join(abs, n), check)
      else if (!st.isFile() || st.nlink > 1) throw bad(path.join(abs, n))
    }
  } finally {
    await d.close()
  }
}

async function installedBy(midsReal: string, name: string, jobId: string): Promise<boolean> {
  const check = insideCheck(midsReal)
  try {
    await readFileVerified(path.join(midsReal, name, "agent/bin/mid.sh"), check, 8 * 1024 * 1024)
    const marker = await readFileVerified(path.join(midsReal, name, MARKER), check, 4096)
    return marker.toString("utf8").trim() === jobId
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT" || (e instanceof MidError && ["not_found", "path_outside", "too_large", "invalid_request"].includes(e.code))) return false
    throw e
  }
}

export async function extractPackage(zipPath: string, name: string, jobId: string, signal?: AbortSignal): Promise<void> {
  validateMidName(name)
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) throw new MidError("invalid_request")
  const midsReal = await fs.promises.realpath(path.join(midRoot(name), ".."))
  const check = insideCheck(midsReal)
  const dir: FileHandle = await openDir(midsReal, check)
  const tmpName = `.extract-${jobId}`
  try {
    if (await installedBy(midsReal, name, jobId)) return
    if (await lstatIn(dir, name)) throw new MidError("conflict")
    if (await lstatIn(dir, tmpName)) await removeIn(dir, midsReal, tmpName, check)
    await mkdirIn(dir, midsReal, tmpName, check)
    const tmpReal = path.join(midsReal, tmpName)
    try {
      await (await openDir(tmpReal, check)).close() // verifies the real location is exactly tmpReal
      try {
        await run("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", tmpReal], {
          env: ENV, timeout: 600_000, maxBuffer: 1024 * 1024, signal,
        })
      } catch (e) {
        if (signal?.aborted || (e as Error).name === "AbortError") throw e
        throw bad((e as Error).message?.slice(0, 200))
      }
      await verifyTree(tmpReal, check)
      const t = await openDir(tmpReal, check)
      try {
        const mk = await createFileIn(t, tmpReal, MARKER, check)
        try {
          await mk.writeFile(jobId)
        } finally {
          await mk.close()
        }
      } finally {
        await t.close()
      }
      if (await lstatIn(dir, name)) throw new MidError("conflict")
      await renameIn(dir, tmpName, name)
    } catch (e) {
      await removeIn(dir, midsReal, tmpName, check).catch(() => {})
      if (e instanceof MidError) throw e
      if ((e as NodeJS.ErrnoException)?.code === "ENOTEMPTY") throw new MidError("conflict")
      throw e
    }
  } finally {
    await dir.close()
  }
}
