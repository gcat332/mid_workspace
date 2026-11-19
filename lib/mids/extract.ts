// Safe extraction of the (untrusted) MID zip into mids/<name>. Everything under mids/ goes through safe-fs
// handles; the only path-based access is by unzip itself, which writes into a temp dir we created and verified
// (its real path is handed over), and the lstat walk afterwards rejects anything unexpected.
// Permissions: unzip honours stored modes; ownership/modes are normalised later by the helper's fixOwnership.
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { createFileIn, fdPath, insideCheck, lstatIn, openDir, openFile, readAll, readFileVerified, removeIn, translateFsError } from "./safe-fs"
import { DEFAULT_MIDHUB_ROOT, MidError, midRoot, validateMidName } from "./names"

const run = promisify(execFile)
// explicit env: no UNZIP/ZIPINFO leakage
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv
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
    // Unix modes are 10 chars; FAT/MS-DOS hosts print 7: [-d][-r][-w][-x][-a][-h][-s] (zipinfo(1): dir, r, w, x, archive,
    // hidden, system). The FAT form can only be a file or directory, so link/device rejection below still holds.
    const m = /^([-dlcbps?][-rwxsStT]{9}|[-d][-r][-w][-x][-a][-h][-s])\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s(.*)$/.exec(line)
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

/** Test hooks. */
export const hooks: { onSpawn?: () => void } = {}

/**
 * Walk of the extracted tree (private 0700 staging, owned by us, so path-based chmod is safe): only regular files
 * (nlink 1) and dirs. Normalises modes: dirs 2775 (setgid keeps the app user's group until fixOwnership), files 0664
 * (0775 if any x bit). A dir is chmod'ed BEFORE it is opened so mode-000 entries cannot wedge the walk or cleanup.
 * Any fs error inside the walk is reported as zip_invalid with the relative path.
 */
async function verifyTree(abs: string, check: (r: string) => void, rel = ""): Promise<void> {
  try {
    const d = await openDir(abs, check)
    try {
      for (const n of await fs.promises.readdir(fdPath(d))) {
        const st = await fs.promises.lstat(fdPath(d, n))
        if (st.isDirectory()) {
          await fs.promises.chmod(fdPath(d, n), 0o2775)
          await verifyTree(path.join(abs, n), check, path.posix.join(rel, n))
        } else if (st.isFile() && st.nlink === 1) {
          await fs.promises.chmod(fdPath(d, n), st.mode & 0o111 ? 0o775 : 0o664)
        } else throw bad(path.posix.join(rel, n))
      }
    } finally {
      await d.close()
    }
  } catch (e) {
    if (e instanceof MidError) throw e
    throw bad(rel || ".")
  }
}

/** Staging-only (private tree): make every dir rwx for us so removal cannot hit EACCES. */
async function unlockTree(abs: string): Promise<void> {
  const st = await fs.promises.lstat(abs)
  if (!st.isDirectory()) return
  await fs.promises.chmod(abs, 0o700)
  for (const n of await fs.promises.readdir(abs)) await unlockTree(path.join(abs, n))
}

/** Trusted "already extracted" only for an app-owned, single-link regular marker holding this jobId. */
async function installedBy(midsReal: string, name: string, jobId: string): Promise<boolean> {
  const check = insideCheck(midsReal)
  try {
    await readFileVerified(path.join(midsReal, name, "agent/bin/mid.sh"), check, 8 * 1024 * 1024)
    const { h, st } = await openFile(path.join(midsReal, name, MARKER), "r", check)
    try {
      if (!st.isFile() || st.uid !== process.getuid!() || st.nlink !== 1) return false
      return (await readAll(h, 4096)).toString("utf8").trim() === jobId
    } finally {
      await h.close()
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT" || (e instanceof MidError && ["not_found", "path_outside", "too_large", "invalid_request", "conflict"].includes(e.code))) return false
    throw e
  }
}

/** ${MIDHUB_ROOT}/staging: a private (0700, ours) directory outside the group-writable mids dir. */
async function stagingDir(): Promise<string> {
  const p = path.join(process.env.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT, "staging")
  await fs.promises.mkdir(p, { mode: 0o700 }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
  })
  const st = await fs.promises.lstat(p)
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)
    throw new MidError("internal", undefined, undefined, `staging ${p} must be a real directory owned by the app with mode 0700`)
  return fs.promises.realpath(p)
}

function unzipError(e: unknown): never {
  const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err.killed || err.signal) throw new MidError("stage_timeout", undefined, undefined, "unzip")
  if (typeof err.code === "number") throw bad(err.message?.slice(0, 200))
  throw new MidError("internal", undefined, undefined, err.message?.slice(0, 200))
}

// Extraction happens in ${MIDHUB_ROOT}/staging (not under mids/, which midsvc can write to), then one rename
// anchored on both verified directory handles moves it into place. (Brief wording ".extract-* under mids" superseded.)
export async function extractPackage(zipPath: string, name: string, jobId: string, signal?: AbortSignal): Promise<void> {
  validateMidName(name)
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) throw new MidError("invalid_request")
  try {
    await extractInner(zipPath, name, jobId, signal)
  } catch (e) {
    if (e instanceof MidError || (e as Error)?.name === "AbortError") throw e
    return translateFsError(e)
  }
}

async function extractInner(zipPath: string, name: string, jobId: string, signal?: AbortSignal): Promise<void> {
  const midsReal = await fs.promises.realpath(path.join(midRoot(name), ".."))
  const midsCheck = insideCheck(midsReal)
  const midsDir = await openDir(midsReal, midsCheck)
  try {
    if (await installedBy(midsReal, name, jobId)) return
    if (await lstatIn(midsDir, name)) throw new MidError("conflict")
    await validateZip(zipPath)
    const stagingReal = await stagingDir()
    const stCheck = insideCheck(stagingReal)
    const stDir = await openDir(stagingReal, stCheck)
    try {
      const tmpName = `.extract-${jobId}`
      const tmpReal = path.join(stagingReal, tmpName)
      const clean = async () => {
        await unlockTree(tmpReal)
        await removeIn(stDir, stagingReal, tmpName, stCheck)
      }
      if (await lstatIn(stDir, tmpName)) {
        await clean().catch((e) => {
          throw new MidError("internal", undefined, undefined, `cannot remove leftover ${tmpName}: ${(e as Error).message}`)
        })
      }
      await fs.promises.mkdir(fdPath(stDir, tmpName), { mode: 0o700 })
      try {
        await (await openDir(tmpReal, stCheck)).close()
        try {
          const p = run("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", tmpReal], { env: ENV, timeout: 600_000, maxBuffer: 1024 * 1024, signal })
          hooks.onSpawn?.()
          await p
        } catch (e) {
          if (signal?.aborted || (e as Error).name === "AbortError") throw e
          unzipError(e)
        }
        await verifyTree(tmpReal, stCheck)
        const t = await openDir(tmpReal, stCheck)
        try {
          const mk = await createFileIn(t, tmpReal, MARKER, stCheck)
          try {
            await mk.writeFile(jobId)
          } finally {
            await mk.close()
          }
        } finally {
          await t.close()
        }
        if (await lstatIn(midsDir, name)) throw new MidError("conflict")
        try {
          await fs.promises.rename(fdPath(stDir, tmpName), fdPath(midsDir, name))
        } catch (e) {
          const c = (e as NodeJS.ErrnoException).code
          if (c === "ENOTDIR" || c === "ENOTEMPTY" || c === "EEXIST") throw new MidError("conflict")
          if (c === "EXDEV") throw new MidError("internal", undefined, undefined, "staging และ mids อยู่คนละ filesystem — ตั้ง MIDHUB_ROOT ให้อยู่ใน filesystem เดียวกัน")
          throw e
        }
      } catch (e) {
        try {
          if (await lstatIn(stDir, tmpName)) await clean()
        } catch (ce) {
          const detail = `cleanup of ${tmpName} failed: ${(ce as Error).message}`
          if (e instanceof MidError) throw new MidError(e.code, e.status, e.message, [e.detail, detail].filter(Boolean).join("; "))
          console.error(detail)
        }
        throw e
      }
    } finally {
      await stDir.close()
    }
  } finally {
    await midsDir.close()
  }
}
