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
const TAIL_CHECK = 64 // bytes before the offset re-verified each poll (copytruncate + regrowth detection)
const MAX_BATCH_LINES = 1000
const MAX_BATCH_BYTES = 256 * 1024

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
  private dropNext = false
  constructor(private max: number) {}

  /** The next completed line is the tail of a line we started in the middle of: discard it. */
  dropFirst(): void { this.dropNext = true }

  push(chunk: Buffer, out: string[]): void {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      const end = nl === -1 ? chunk.length : nl
      this.add(chunk.subarray(start, end))
      if (nl === -1) return
      const l = this.take()
      if (l !== null) out.push(l)
      start = nl + 1
    }
  }
  /** Emit a held partial line (file rotated away: it will never be completed). */
  flush(out: string[]): void {
    if (this.len > 0 || this.over) {
      const l = this.take()
      if (l !== null) out.push(l)
    }
  }
  reset(): void { this.pending = []; this.len = 0; this.over = false; this.dropNext = false }

  private add(seg: Buffer): void {
    if (this.over || seg.length === 0) return
    const room = this.max - this.len
    if (seg.length > room) { this.pending.push(seg.subarray(0, room)); this.len = this.max; this.over = true } else { this.pending.push(seg); this.len += seg.length }
  }
  private take(): string | null {
    let s = Buffer.concat(this.pending).toString("utf8")
    if (s.endsWith("\r")) s = s.slice(0, -1)
    if (this.over) s += "…"
    const drop = this.dropNext
    this.pending = []; this.len = 0; this.over = false; this.dropNext = false
    return drop ? null : s
  }
}

type Cur = { h: FileHandle; dev: number; ino: number; offset: number; last: Buffer }
type Opened = Awaited<ReturnType<OpenFn>>

export async function* tailFile(open: OpenFn, opts: TailOpts): AsyncGenerator<string[], void, void> {
  const { signal, pollMs } = opts
  const split = new LineSplitter(opts.maxLineBytes ?? 16 * 1024)
  let cur: Cur | null = null
  let status: "missing" | "live" | null = null
  const setStatus = (s: "missing" | "live") => { if (s !== status) { status = s; opts.onStatus?.(s) } }
  let first = true
  let idle = 0
  let polls = 0

  /** Read from the handle's own offset until `out` is full (lines/bytes) or EOF. Returns whether more may remain. */
  async function drain(c: Cur, out: string[]): Promise<{ grew: boolean; more: boolean }> {
    const size = (await c.h.stat()).size
    if (size < c.offset) { c.offset = 0; c.last = Buffer.alloc(0); split.reset() } // truncated in place: restart on the same handle
    else if (c.offset > 0 && c.last.length > 0) {
      // Truncated and regrown past our offset within one poll: the bytes just before the offset no longer match.
      const probe = Buffer.alloc(c.last.length)
      const { bytesRead } = await c.h.read(probe, 0, probe.length, c.offset - c.last.length)
      if (bytesRead !== probe.length || !probe.equals(c.last)) { c.offset = 0; c.last = Buffer.alloc(0); split.reset() }
    }
    if (size === c.offset) return { grew: false, more: false }
    const buf = Buffer.allocUnsafe(CHUNK)
    let bytes = 0
    while (c.offset < size && !signal.aborted) {
      if (out.length >= MAX_BATCH_LINES || bytes >= MAX_BATCH_BYTES) return { grew: true, more: true }
      const { bytesRead } = await c.h.read(buf, 0, Math.min(CHUNK, size - c.offset), c.offset)
      if (bytesRead === 0) break
      c.offset += bytesRead
      bytes += bytesRead
      const part = buf.subarray(0, bytesRead)
      c.last = Buffer.concat([c.last, part]).subarray(-TAIL_CHECK)
      split.push(part, out)
    }
    return { grew: true, more: false }
  }

  /** Drain to EOF in bounded batches; returns whether anything was read. */
  async function* drainAll(c: Cur): AsyncGenerator<string[], boolean, void> {
    let any = false
    for (;;) {
      const out: string[] = []
      const r = await drain(c, out)
      any ||= r.grew
      for (let i = 0; i < out.length; i += MAX_BATCH_LINES) yield out.slice(i, i + MAX_BATCH_LINES)
      if (!r.more || signal.aborted) return any
    }
  }

  try {
    while (!signal.aborted) {
      if (!cur) {
        let o: Opened
        try {
          o = await open()
        } catch (e) {
          if (first && !isMissing(e)) throw e
          setStatus("missing")
          await sleep(pollMs, signal)
          continue
        }
        let start = first ? Math.max(0, o.st.size - Math.max(0, opts.fromBytesBack)) : 0
        first = false
        split.reset()
        try {
          if (start > 0) {
            // Skip the partial line we landed in (byte start-1 is the previous line's "\n" when we landed on a boundary).
            const b = Buffer.alloc(8192)
            let p = start - 1
            for (;;) {
              const { bytesRead } = await o.h.read(b, 0, b.length, p)
              if (bytesRead === 0) { split.dropFirst(); break } // EOF inside a line: its remainder is a fragment
              const nl = b.subarray(0, bytesRead).indexOf(0x0a)
              if (nl >= 0) { p += nl + 1; break }
              p += bytesRead
            }
            start = p
          }
        } catch (e) { await o.h.close().catch(() => {}); throw e }
        cur = { h: o.h, dev: o.st.dev, ino: o.st.ino, offset: start, last: Buffer.alloc(0) }
        setStatus("live")
      }

      const grew = yield* drainAll(cur)
      idle = grew ? 0 : idle + 1
      polls++
      if (polls % REOPEN_EVERY === 0 || idle >= IDLE_REOPEN) {
        let fresh: Opened | null = null
        try { fresh = await open() } catch { fresh = null } // missing / failed verification: keep what we have
        if (fresh) {
          if (fresh.st.ino !== cur.ino || fresh.st.dev !== cur.dev) {
            let adopted = false
            try {
              yield* drainAll(cur) // finish the old file
              const tail: string[] = []
              split.flush(tail)
              if (tail.length) yield tail
              await cur.h.close()
              adopted = true
            } finally {
              if (!adopted) await fresh.h.close().catch(() => {}) // error or consumer return mid-rotation: would otherwise leak
            }
            cur = { h: fresh.h, dev: fresh.st.dev, ino: fresh.st.ino, offset: 0, last: Buffer.alloc(0) }
            idle = 0
            yield* drainAll(cur)
          } else {
            await fresh.h.close()
          }
        }
      }
      await sleep(pollMs, signal)
    }
  } finally {
    if (cur) await cur.h.close().catch(() => {})
  }
}
