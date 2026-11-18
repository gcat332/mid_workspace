// Live tail over fd-anchored handles. Every handle comes from `open` (which must verify it, see safe-fs.openFile);
// bytes are only ever read from a handle with positional reads, never by path, so a symlink swapped in by the
// MID process after the check cannot redirect what we read.
import type { FileHandle } from "node:fs/promises"
import type { Stats } from "node:fs"

export type OpenFn = () => Promise<{ h: FileHandle; st: Stats }>
export type TailOpts = {
  fromBytesBack: number
  pollMs: number
  signal: AbortSignal
  /** Single line cap in bytes (default 16 KiB); longer lines are cut and end with "…". */
  maxLineBytes?: number
  /** Called when the file disappears / appears (UI status). */
  onStatus?: (s: "missing" | "live") => void
}

const CHUNK = 64 * 1024
const REOPEN_EVERY = 5
const IDLE_REOPEN = 2

const isMissing = (e: unknown): boolean => {
  const x = e as { code?: string } | null
  return x?.code === "ENOENT" || x?.code === "not_found"
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => { clearTimeout(t); signal.removeEventListener("abort", done); resolve() }
    const t = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

class LineSplitter {
  private pending: Buffer[] = []
  private len = 0
  private over = false
  constructor(private max: number) {}

  push(chunk: Buffer, out: string[]): void {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      const end = nl === -1 ? chunk.length : nl
      this.add(chunk.subarray(start, end))
      if (nl === -1) return
      out.push(this.take())
      start = nl + 1
    }
  }
  /** Emit a held partial line (file rotated away: it will never be completed). */
  flush(out: string[]): void {
    if (this.len > 0 || this.over) out.push(this.take())
  }
  reset(): void { this.pending = []; this.len = 0; this.over = false }

  private add(seg: Buffer): void {
    if (this.over || seg.length === 0) return
    const room = this.max - this.len
    if (seg.length > room) { this.pending.push(seg.subarray(0, room)); this.len = this.max; this.over = true } else { this.pending.push(seg); this.len += seg.length }
  }
  private take(): string {
    let s = Buffer.concat(this.pending).toString("utf8")
    if (s.endsWith("\r")) s = s.slice(0, -1)
    if (this.over) s += "…"
    this.reset()
    return s
  }
}

type Cur = { h: FileHandle; dev: number; ino: number; offset: number }

export async function* tailFile(open: OpenFn, opts: TailOpts): AsyncGenerator<string[], void, void> {
  const { signal, pollMs } = opts
  const split = new LineSplitter(opts.maxLineBytes ?? 16 * 1024)
  let cur: Cur | null = null
  let status: "missing" | "live" | null = null
  const setStatus = (s: "missing" | "live") => { if (s !== status) { status = s; opts.onStatus?.(s) } }
  let first = true
  let idle = 0
  let polls = 0

  /** Read everything currently in the file from the handle's own offset. */
  async function drain(c: Cur, out: string[]): Promise<boolean> {
    const size = (await c.h.stat()).size
    if (size < c.offset) { c.offset = 0; split.reset() } // truncated in place: restart on the same handle
    if (size === c.offset) return false
    const buf = Buffer.allocUnsafe(CHUNK)
    while (c.offset < size && !signal.aborted) {
      const { bytesRead } = await c.h.read(buf, 0, Math.min(CHUNK, size - c.offset), c.offset)
      if (bytesRead === 0) break
      c.offset += bytesRead
      split.push(buf.subarray(0, bytesRead), out)
    }
    return true
  }

  try {
    while (!signal.aborted) {
      const out: string[] = []
      if (!cur) {
        let o: Awaited<ReturnType<OpenFn>>
        try {
          o = await open()
        } catch (e) {
          if (first ? !isMissing(e) : false) throw e
          setStatus("missing")
          await sleep(pollMs, signal)
          continue
        }
        const start = first ? Math.max(0, o.st.size - Math.max(0, opts.fromBytesBack)) : 0
        cur = { h: o.h, dev: o.st.dev, ino: o.st.ino, offset: start }
        first = false
        setStatus("live")
        split.reset()
        if (start > 0) {
          // Skip the partial line we landed in (byte start-1 is the previous line's "\n" when we landed on a boundary).
          const b = Buffer.alloc(1)
          let p = start - 1
          for (;;) {
            const { bytesRead } = await o.h.read(b, 0, 1, p)
            if (bytesRead === 0) { cur.offset = p; break }
            p++
            if (b[0] === 0x0a) { cur.offset = p; break }
          }
        }
      }

      const grew = await drain(cur, out)
      idle = grew ? 0 : idle + 1
      polls++
      if (polls % REOPEN_EVERY === 0 || idle >= IDLE_REOPEN) {
        let fresh: Awaited<ReturnType<OpenFn>> | null = null
        try { fresh = await open() } catch { fresh = null } // missing / failed verification: keep what we have
        if (fresh) {
          if (fresh.st.ino !== cur.ino || fresh.st.dev !== cur.dev) {
            await drain(cur, out) // finish the old file
            split.flush(out)
            await cur.h.close()
            cur = { h: fresh.h, dev: fresh.st.dev, ino: fresh.st.ino, offset: 0 }
            idle = 0
            await drain(cur, out)
          } else {
            await fresh.h.close()
          }
        }
      }
      if (out.length) yield out
      await sleep(pollMs, signal)
    }
  } finally {
    if (cur) await cur.h.close().catch(() => {})
  }
}
