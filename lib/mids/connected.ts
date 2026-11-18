import { CONNECTED_MARKER } from "./layout"
import { openLog } from "./files"
import { tailFile } from "./log-tail"
import { MidError } from "./names"

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_ERR_LINES = 20
const ERR_LINE_CAP = 300
const TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})/

/** Leading ISO timestamp with offset (e.g. 2026-11-18T22:40:42.895+0700) -> epoch ms, or null. */
export function parseLineTime(line: string): number | null {
  const m = TS_RE.exec(line)
  if (!m) return null
  const off = m[3] === "Z" || m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`
  const t = Date.parse(`${m[1]}T${m[2]}${off}`)
  return Number.isNaN(t) ? null : t
}

const sanitize = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, ERR_LINE_CAP)

/**
 * Limitation: only the current agent0.log.0 is tailed (tailFile follows a rotation of that name, but lines already
 * rotated into older files before the first poll are not read). A marker rotated out within the wait is missed.
 */
export async function waitConnected(
  name: string,
  since: Date,
  opts: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  const { signal } = opts
  if (signal?.aborted) throw signal.reason
  const open = await openLog(name, "main")
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const errors: string[] = []
  const sinceMs = since.getTime()
  try {
    for await (const batch of tailFile(open, { fromBytesBack: Number.MAX_SAFE_INTEGER, pollMs: opts.pollMs ?? 500, signal: ac.signal })) {
      for (const line of batch) {
        const ts = parseLineTime(line)
        if (ts === null) continue
        if (ts >= sinceMs && line.includes(CONNECTED_MARKER)) return
        if (ts >= sinceMs && /ERROR|SEVERE/.test(line)) {
          errors.push(sanitize(line))
          if (errors.length > MAX_ERR_LINES) errors.shift()
        }
      }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
  if (signal?.aborted) throw signal.reason
  if (timedOut) throw new MidError("connect_timeout", undefined, undefined, errors.length ? errors.join("\n") : undefined)
}
