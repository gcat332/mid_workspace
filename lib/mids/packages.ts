import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { prisma } from "@/lib/db/client"
import { BUILDSTAMP_RE, packageUrl } from "./buildstamp"
import { DEFAULT_MIDHUB_ROOT, MidError } from "./names"

const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
const MAX_REDIRECTS = 3
const STALE_PART_MS = 24 * 3600_000
const DU_TIMEOUT_MS = 20_000
const DU_CACHE_MS = 60_000

// Read per call (like midRoot) so tests and the root helper can point at a temp root.
const rootDir = (): string => process.env.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT
const packagesDir = (): string => path.join(rootDir(), "packages")

export function packagePath(buildstamp: string): string {
  if (!BUILDSTAMP_RE.test(buildstamp)) throw new MidError("invalid_buildstamp")
  return path.join(packagesDir(), `${buildstamp}.zip`)
}

type Listener = (done: number, total: number | null) => void
type Entry = { p: Promise<string>; listeners: Set<Listener> }
// Thrown inside the owner's download when the owner's own signal aborted: waiters take over instead of failing.
class OwnerAborted extends Error {
  constructor(readonly reason: unknown) {
    super("owner aborted")
  }
}

// On globalThis (like lib/jobs/engine.ts) so route bundles and HMR share one map.
const PKG_STATE = Symbol.for("midhub.packages")
const inflight = (): Map<string, Entry> => {
  const g = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>
  return (g[PKG_STATE] ??= new Map())
}

const exists = (p: string): Promise<boolean> =>
  fs.promises.lstat(p).then(
    (s) => s.isFile(),
    () => false,
  )

// https only, a real *.service-now.com subdomain, no credentials, default port.
const isServiceNow = (u: URL): boolean =>
  u.protocol === "https:" && u.hostname.endsWith(".service-now.com") && u.hostname.length > ".service-now.com".length && !u.username && !u.password && u.port === ""

async function fetchFollowing(url: string, signal: AbortSignal): Promise<Response> {
  let cur = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(cur, { redirect: "manual", signal, headers: { "accept-encoding": "identity" } })
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      await res.body?.cancel().catch(() => {})
      const next = new URL(res.headers.get("location")!, cur)
      if (!isServiceNow(next)) throw new MidError("package_download", undefined, undefined, `redirect to disallowed target ${next.origin}`)
      cur = next.toString()
      continue
    }
    return res
  }
  throw new MidError("package_download", undefined, undefined, "too many redirects")
}

type Opts = { onProgress?(done: number, total: number | null): void; signal?: AbortSignal; urlFor?: (b: string) => string }

async function download(buildstamp: string, final: string, opts: Opts, listeners: Set<Listener>): Promise<string> {
  const part = `${final}.part`
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error("download timed out")), DOWNLOAD_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal
  try {
    await fs.promises.mkdir(path.dirname(final), { recursive: true, mode: 0o750 })
    const res = await fetchFollowing((opts.urlFor ?? packageUrl)(buildstamp), signal)
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      throw new MidError("package_not_found")
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {})
      throw new MidError("package_download", undefined, undefined, `HTTP ${res.status}`)
    }
    const lenHeader = res.headers.get("content-length")
    const total = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null
    let done = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length
        for (const l of listeners) l(done, total)
        cb(null, chunk)
      },
    })
    // Unlink first, then exclusive create: never write through a pre-planted file or symlink.
    await fs.promises.rm(part, { force: true })
    const fh = await fs.promises.open(part, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o640)
    await pipeline(Readable.fromWeb(res.body as never), counter, fh.createWriteStream(), { signal })
    if (total !== null && done !== total) {
      throw new MidError("package_download", undefined, undefined, `received ${done} of ${total} bytes`)
    }
    await fs.promises.rename(part, final)
    return final
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {})
    if (opts.signal?.aborted) throw new OwnerAborted(opts.signal.reason ?? e)
    if (e instanceof MidError) throw e
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new MidError("disk_low")
    throw new MidError("package_download", undefined, undefined, e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

// Rejects with signal.reason as soon as the signal aborts; does not cancel `p`.
function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

export async function ensurePackage(buildstamp: string, opts: Opts = {}): Promise<string> {
  const final = packagePath(buildstamp)
  if (opts.signal?.aborted) throw opts.signal.reason
  if (await exists(final)) return final
  const map = inflight()
  for (;;) {
    const running = map.get(buildstamp)
    if (running) {
      const l = opts.onProgress
      if (l) running.listeners.add(l)
      try {
        return await raceSignal(running.p, opts.signal)
      } catch (e) {
        if (opts.signal?.aborted) throw opts.signal.reason
        // The owner's cancellation must not fail us; take over as the new owner.
        if (e instanceof OwnerAborted) continue
        throw e
      } finally {
        if (l) running.listeners.delete(l)
      }
    }
    // Register synchronously (no await between the map check and set) so a second caller always joins.
    const listeners = new Set<Listener>()
    if (opts.onProgress) listeners.add(opts.onProgress)
    const p = (async () => ((await exists(final)) ? final : download(buildstamp, final, opts, listeners)))()
    map.set(buildstamp, { p, listeners })
    const clear = () => {
      if (map.get(buildstamp)?.p === p) map.delete(buildstamp)
    }
    p.then(clear, clear)
    try {
      return await p
    } catch (e) {
      if (e instanceof OwnerAborted) throw e.reason
      throw e
    }
  }
}

export async function listPackages(): Promise<{ buildstamp: string; bytes: number }[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(packagesDir())
  } catch {
    return []
  }
  const out: { buildstamp: string; bytes: number }[] = []
  for (const n of names) {
    if (!n.endsWith(".zip")) continue
    const buildstamp = n.slice(0, -4)
    if (!BUILDSTAMP_RE.test(buildstamp)) continue
    const st = await fs.promises.stat(path.join(packagesDir(), n)).catch(() => null)
    if (st?.isFile()) out.push({ buildstamp, bytes: st.size })
  }
  return out.sort((a, b) => a.buildstamp.localeCompare(b.buildstamp))
}

function jobBuildstamp(params: string): string | null {
  try {
    const v = (JSON.parse(params) as { buildstamp?: unknown }).buildstamp
    return typeof v === "string" ? v : null
  } catch {
    return null
  }
}

export async function gcPackages(): Promise<string[]> {
  const [mids, jobs] = await Promise.all([
    prisma.midServer.findMany({ where: { removedAt: null }, select: { version: true, instanceId: true } }),
    prisma.job.findMany({ where: { status: { in: ["queued", "running", "failed"] } }, select: { params: true } }),
  ])
  const keep = new Set<string>()
  for (const m of mids) if (m.version) keep.add(m.version)
  // Imported MIDs have version null: keep the build their Instance last reported (Instance.buildstamp is a cached field).
  const instanceIds = [...new Set(mids.flatMap((m) => (m.instanceId ? [m.instanceId] : [])))]
  if (instanceIds.length) {
    const insts = await prisma.instance.findMany({ where: { id: { in: instanceIds } }, select: { buildstamp: true } })
    for (const i of insts) if (i.buildstamp) keep.add(i.buildstamp)
  }
  for (const j of jobs) {
    const b = jobBuildstamp(j.params)
    if (b) keep.add(b)
  }
  const dir = packagesDir()
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const map = inflight()
  const deleted: string[] = []
  for (const n of names) {
    const m = /^(.+)\.zip(\.part)?$/.exec(n)
    if (!m || map.has(m[1])) continue
    const full = path.join(dir, n)
    if (m[2]) {
      const st = await fs.promises.stat(full).catch(() => null)
      if (!st || Date.now() - st.mtimeMs < STALE_PART_MS) continue
    } else if (keep.has(m[1])) continue
    try {
      await fs.promises.rm(full, { force: true })
      deleted.push(n)
    } catch (e) {
      console.warn(`[packages] gc cannot delete ${n}:`, (e as Error).message)
    }
  }
  return deleted
}

export type DiskStatus = {
  freeBytes: number | null // null when statfs failed (degraded)
  totalBytes: number | null
  usage: { mids: number; packages: number; archive: number } | null
}

type Usage = NonNullable<DiskStatus["usage"]>
type DuState = { at: number; usage: Usage | null; pending: Promise<void> | null }
const DU_STATE = Symbol.for("midhub.packages.du")
const duState = (): DuState => {
  const g = globalThis as unknown as Record<symbol, DuState | undefined>
  return (g[DU_STATE] ??= { at: 0, usage: null, pending: null })
}
const warned = new Set<string>()
const warnOnce = (k: string, e: unknown) => {
  if (warned.has(k)) return
  warned.add(k)
  console.warn(`[packages] ${k}:`, (e as Error).message)
}

const du = (dir: string): Promise<number> =>
  fs.promises.stat(dir).then(
    () =>
      new Promise<number>((resolve, reject) => {
        execFile("/usr/bin/du", ["-sb", dir], { timeout: DU_TIMEOUT_MS }, (err, stdout) => {
          const n = Number(String(stdout).split(/\s/)[0])
          // du exits non-zero on unreadable subdirs but still prints a total; accept that.
          if (Number.isFinite(n) && stdout) resolve(n)
          else reject(err ?? new Error("unparseable du output"))
        })
      }),
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return 0
      throw e
    },
  )

// Never waits for du: serves the cached (possibly stale) value and refreshes in the background, one refresh at a time.
function readUsage(): Usage | null {
  const st = duState()
  if (Date.now() - st.at >= DU_CACHE_MS && !st.pending) {
    const r = rootDir()
    st.pending = Promise.all(["mids", "packages", "archive"].map((d) => du(path.join(r, d))))
      .then(([mids, packages, archive]) => {
        st.usage = { mids, packages, archive }
      })
      .catch((e) => {
        st.usage = null
        warnOnce("disk usage unavailable", e)
      })
      .finally(() => {
        st.at = Date.now()
        st.pending = null
      })
  }
  return st.usage
}

export async function diskStatus(): Promise<DiskStatus> {
  const usage = readUsage()
  try {
    const s = await fs.promises.statfs(rootDir())
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, usage }
  } catch (e) {
    warnOnce("statfs failed", e)
    return { freeBytes: null, totalBytes: null, usage }
  }
}
