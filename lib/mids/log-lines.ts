// "Last N lines" of a log over a verified handle (AgentHub GET logs). Like log-tail.ts, bytes are only read with
// positional reads from the handle `open` returns (O_NOFOLLOW + /proc/self/fd verified), never by path.
import type { OpenFn } from "./log-tail"

export const MAX_LOG_READ_BYTES = 2 * 1024 * 1024
const CHUNK = 64 * 1024

/**
 * Reads backwards from EOF (as of the open) until `n` complete lines or `maxBytes` were read. Oldest first; a trailing
 * newline does not add an empty line and "\r" is stripped. When the read stops before the start of the file, the first
 * (cut) line is dropped. A file that shrinks while being read ends the read early (best effort).
 */
export async function readLastLines(open: OpenFn, n: number, maxBytes: number = MAX_LOG_READ_BYTES): Promise<string[]> {
  if (n <= 0) return []
  const { h, st } = await open()
  try {
    const limit = Math.min(st.size, maxBytes)
    const chunks: Buffer[] = []
    let pos = st.size
    let newlines = 0
    let complete = true // reached the start of the file
    let trailingNl = false
    while (st.size - pos < limit) {
      const len = Math.min(CHUNK, limit - (st.size - pos))
      const buf = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const { bytesRead } = await h.read(buf, got, len - got, pos - len + got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      if (got < len) { complete = false; break } // truncated under us
      pos -= len
      if (chunks.length === 0) trailingNl = buf[len - 1] === 0x0a
      chunks.unshift(buf)
      for (let i = 0; i < len; i++) if (buf[i] === 0x0a) newlines++
      // newlines (minus the file's own terminator) = complete lines after the first, possibly cut, one
      if (newlines - (trailingNl ? 1 : 0) >= n) break
    }
    if (pos > 0) complete = false
    let text = Buffer.concat(chunks).toString("utf8")
    if (trailingNl) text = text.slice(0, -1)
    if (text === "" && complete) return []
    const lines = text.split("\n")
    if (!complete) lines.shift()
    return lines.slice(-n).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  } finally {
    await h.close()
  }
}
