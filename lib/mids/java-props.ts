import { MidError } from "./names"

// Minimal java .properties reader/writer. Separators handled: "=", ":" and whitespace, with optional
// surrounding blanks. Continuation lines (odd number of trailing backslashes) are skipped when looking
// for a key and joined by readProp; setProp refuses to rewrite a key whose value spans lines.
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

function continues(line: string): boolean {
  const m = /\\+$/.exec(line)
  return m !== null && m[0].length % 2 === 1
}

function stripCr(raw: string): string {
  return raw.endsWith("\r") ? raw.slice(0, -1) : raw
}

// Index of the first key line (never a comment or a continuation of an earlier line), or -1.
function findKey(lines: string[], key: string): { index: number; value: string } | null {
  const re = lineRe(key)
  let inCont = false
  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i])
    if (inCont) {
      inCont = continues(line)
      continue
    }
    if (isComment(line)) continue
    const m = re.exec(line)
    if (m) return { index: i, value: m[1] }
    inCont = continues(line)
  }
  return null
}

export function readProp(text: string, key: string): string | null {
  const lines = text.split("\n")
  const hit = findKey(lines, key)
  if (!hit) return null
  let value = hit.value
  let i = hit.index
  while (continues(stripCr(lines[i])) && i + 1 < lines.length) {
    value = value.slice(0, -1) + stripCr(lines[i + 1]).replace(/^[ \t\f]+/, "")
    i++
  }
  if (continues(value)) value = value.slice(0, -1)
  return value.trim()
}

export function setProp(text: string, key: string, value: string): string {
  if (!/^[A-Za-z0-9_.\-]+$/.test(key)) throw new MidError("invalid_request", undefined, undefined, "invalid property key")
  if (/[\r\n\0]/.test(value)) throw new MidError("invalid_request", undefined, undefined, `invalid value for property ${key}`)
  if (continues(value)) throw new MidError("invalid_request", undefined, undefined, `value for property ${key} ends with a backslash`)
  const crlf = text.includes("\r\n")
  const lines = text.split("\n")
  const hit = findKey(lines, key)
  if (hit) {
    const raw = lines[hit.index]
    if (continues(stripCr(raw))) {
      throw new MidError("invalid_request", undefined, undefined, `property ${key} spans multiple lines`)
    }
    lines[hit.index] = `${key}=${value}${raw.endsWith("\r") ? "\r" : ""}`
    return lines.join("\n")
  }
  const eol = crlf ? "\r\n" : "\n"
  const base = text === "" || text.endsWith("\n") ? text : text + eol
  return `${base}${key}=${value}${eol}`
}
