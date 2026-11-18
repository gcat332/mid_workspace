// Minimal java .properties reader/writer for single-line entries (no continuation lines).
// Separators handled: "=", ":" and whitespace, with optional surrounding blanks.
const WS = "[ \\t\\f]"

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lineRe(key: string): RegExp {
  return new RegExp(`^${WS}*${escapeRe(key)}(?:${WS}*[=:]${WS}*|${WS}+|$)(.*)$`)
}

function isComment(line: string): boolean {
  return /^[ \t\f]*[#!]/.test(line)
}

export function readProp(text: string, key: string): string | null {
  const re = lineRe(key)
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (isComment(line)) continue
    const m = re.exec(line)
    if (m) return m[1].trim()
  }
  return null
}

export function setProp(text: string, key: string, value: string): string {
  const crlf = text.includes("\r\n")
  const re = lineRe(key)
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const cr = raw.endsWith("\r")
    const line = cr ? raw.slice(0, -1) : raw
    if (isComment(line) || !re.test(line)) continue
    lines[i] = `${key}=${value}${cr ? "\r" : ""}`
    return lines.join("\n")
  }
  const eol = crlf ? "\r\n" : "\n"
  const base = text === "" || text.endsWith("\n") ? text : text + eol
  return `${base}${key}=${value}${eol}`
}
