import { XMLParser, XMLValidator } from "fast-xml-parser"

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseAttributeValue: false })

/** Reads `<parameter name value>` pairs from a MID config.xml. */
export function readParams(xml: string): Record<string, string> {
  const root = parser.parse(xml)?.parameters
  const list = root && typeof root === "object" ? root.parameter : undefined
  const out: Record<string, string> = {}
  for (const p of [list].flat()) {
    if (p && typeof p === "object" && typeof p["@_name"] === "string") out[p["@_name"]] = String(p["@_value"] ?? "")
  }
  return out
}

export function validateXml(xml: string): { ok: true } | { ok: false; line: number; message: string } {
  const r = XMLValidator.validate(xml)
  if (r === true) return { ok: true }
  return { ok: false, line: r.err.line, message: r.err.msg }
}

const escAttr = (v: string, quote: string): string => {
  const s = v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return quote === "'" ? s.replace(/'/g, "&apos;") : s.replace(/"/g, "&quot;")
}

// Comments are matched first so a commented-out <parameter> is never edited. Quoted attribute values may contain '>'.
const TOKEN = /<!--[\s\S]*?-->|<parameter\b(?:[^>"']|"[^"]*"|'[^']*')*>/g
const ATTR = (n: string) => new RegExp(`(\\s${n}\\s*=\\s*)(?:"([^"]*)"|'([^']*)')`)

/**
 * Sets the `value` attribute of existing `<parameter name="X">` elements by editing the text in place
 * (no re-serialisation, so every other byte is untouched). Missing keys are appended before `</parameters>`.
 */
export function setParams(xml: string, changes: Record<string, string>): string {
  const pending = new Map(Object.entries(changes))
  let out = xml.replace(TOKEN, (tag) => {
    if (tag.startsWith("<!--")) return tag
    const nm = ATTR("name").exec(tag)
    const name = nm ? (nm[2] ?? nm[3]) : undefined
    if (name === undefined || !pending.has(name)) return tag
    const value = pending.get(name) as string
    pending.delete(name)
    const val = ATTR("value").exec(tag)
    if (val) {
      const q = val[2] !== undefined ? '"' : "'"
      return tag.replace(ATTR("value"), (_m, pre: string) => `${pre}${q}${escAttr(value, q)}${q}`)
    }
    return tag.replace(/(\s*\/?>)$/, ` value="${escAttr(value, '"')}"$1`)
  })
  if (pending.size === 0) return out

  let close = -1
  for (const m of out.matchAll(new RegExp(`${TOKEN.source}|<\\/parameters\\s*>`, "g"))) {
    if (/^<\/parameters/.test(m[0])) close = m.index
  }
  if (close < 0) throw new Error("config.xml has no </parameters> element to add parameters to")
  const lineStart = out.lastIndexOf("\n", close - 1) + 1
  const own = /^[ \t]*$/.test(out.slice(lineStart, close))
  const prev = [...out.slice(0, close).matchAll(/^([ \t]*)<parameter\b/gm)].pop()
  const indent = prev ? prev[1] : "  "
  const els = [...pending].map(([k, v]) => `<parameter name="${escAttr(k, '"')}" value="${escAttr(v, '"')}"/>`)
  if (own) {
    out = out.slice(0, lineStart) + els.map((e) => `${indent}${e}\n`).join("") + out.slice(lineStart)
  } else {
    out = out.slice(0, close) + els.join("") + out.slice(close)
  }
  return out
}
