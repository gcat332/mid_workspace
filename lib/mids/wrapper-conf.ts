const LINE = /^([ \t]*wrapper\.java\.maxmemory[ \t]*=[ \t]*)(\d+)([ \t]*)(?=\r?$)/m

export function readHeapMb(conf: string): number | null {
  const m = LINE.exec(conf)
  return m ? Number(m[2]) : null
}

/** Replaces the `wrapper.java.maxmemory` line in place (CRLF preserved), or appends it. */
export function setHeapMb(conf: string, mb: number): string {
  if (!Number.isInteger(mb) || mb <= 0) throw new Error("heap must be a positive integer (MB)")
  if (LINE.test(conf)) return conf.replace(LINE, (_m, pre: string, _v, post: string) => `${pre}${mb}${post}`)
  const eol = conf.includes("\r\n") ? "\r\n" : "\n"
  const sep = conf === "" || conf.endsWith("\n") ? "" : eol
  return `${conf}${sep}wrapper.java.maxmemory=${mb}${eol}`
}
