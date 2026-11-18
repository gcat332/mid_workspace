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

const inflight = new Map<string, Promise<string>>()

const exists = (p: string): Promise<boolean> =>
  fs.promises.stat(p).then(
    (s) => s.isFile(),
    () => false,
  )

const isServiceNow = (u: URL): boolean => u.protocol === "https:" && (u.hostname === "service-now.com" || u.hostname.endsWith(".service-now.com"))

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

async function download(buildstamp: string, final: string, opts: Opts): Promise<string> {
  const part = `${final}.part`
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  try {
    await fs.promises.mkdir(path.dirname(final), { recursive: true, mode: 0o750 })
    const res = await fetchFollowing((opts.urlFor ?? packageUrl)(buildstamp), signal)
    if (res.status === 404) throw new MidError("package_not_found")
    if (!res.ok || !res.body) throw new MidError("package_download", undefined, undefined, `HTTP ${res.status}`)
    const lenHeader = res.headers.get("content-length")
    const total = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null
    let done = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length
        opts.onProgress?.(done, total)
        cb(null, chunk)
      },
    })
    const out = fs.createWriteStream(part, { flags: "w", mode: 0o640 })
    await pipeline(Readable.fromWeb(res.body as never), counter, out, { signal })
    if (total !== null && done !== total) {
      throw new MidError("package_download", undefined, undefined, `received ${done} of ${total} bytes`)
    }
    await fs.promises.rename(part, final)
    return final
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {})
    if (e instanceof MidError) throw e
    if (opts.signal?.aborted) throw opts.signal.reason ?? e
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new MidError("disk_low")
    throw new MidError("package_download", undefined, undefined, e instanceof Error ? e.message : String(e))
  }
}

export async function ensurePackage(buildstamp: string, opts: Opts = {}): Promise<string> {
  const final = packagePath(buildstamp)
  if (await exists(final)) return final
  for (;;) {
    const running = inflight.get(buildstamp)
    if (running) {
      try {
        return await running
      } catch (e) {
        // The first caller's abort must not fail us; retry as the new owner.
        if (opts.signal?.aborted || e instanceof MidError) throw e
        continue
      }
    }
    // Register synchronously (no await between the map check and set) so a second caller always joins.
    const p = (async () => ((await exists(final)) ? final : download(buildstamp, final, opts)))()
    inflight.set(buildstamp, p)
    const clear = () => {
      if (inflight.get(buildstamp) === p) inflight.delete(buildstamp)
    }
    p.then(clear, clear)
    return p
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
    prisma.midServer.findMany({ where: { removedAt: null }, select: { version: true } }),
    prisma.job.findMany({ where: { status: { in: ["queued", "running", "failed"] } }, select: { params: true } }),
  ])
  const keep = new Set<string>()
  for (const m of mids) if (m.version) keep.add(m.version)
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
  const deleted: string[] = []
  for (const n of names) {
    const m = /^(.+)\.zip(\.part)?$/.exec(n)
    if (!m || inflight.has(m[1])) continue
    const full = path.join(dir, n)
    if (m[2]) {
      const st = await fs.promises.stat(full).catch(() => null)
      if (!st || Date.now() - st.mtimeMs < STALE_PART_MS) continue
    } else if (keep.has(m[1])) continue
    await fs.promises.rm(full, { force: true })
    deleted.push(n)
  }
  return deleted
}

export type DiskStatus = {
  freeBytes: number
  totalBytes: number
  usage: { mids: number; packages: number; archive: number } | null
}

type DuCache = { at: number; usage: DiskStatus["usage"] }
const CACHE_KEY = "__midhubDiskCache"
let warned = false

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

async function readUsage(): Promise<DiskStatus["usage"]> {
  const g = globalThis as unknown as Record<string, DuCache | undefined>
  const c = g[CACHE_KEY]
  if (c && Date.now() - c.at < DU_CACHE_MS) return c.usage
  let usage: DiskStatus["usage"] = null
  try {
    const r = rootDir()
    const [mids, packages, archive] = await Promise.all(["mids", "packages", "archive"].map((d) => du(path.join(r, d))))
    usage = { mids, packages, archive }
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn("[packages] disk usage unavailable:", (e as Error).message)
    }
  }
  g[CACHE_KEY] = { at: Date.now(), usage }
  return usage
}

export async function diskStatus(): Promise<DiskStatus> {
  const s = await fs.promises.statfs(rootDir())
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, usage: await readUsage() }
}
