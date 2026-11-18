import { XMLValidator } from "fast-xml-parser"
import { MidError } from "./names"

// One tokenizer feeds both readParams and setParams so they agree on what "the parameter" is.
// Attributes are parsed left to right as name=quoted-value pairs, so text inside a quoted value
// (`name="zz"`, `/>`, `>`) can never be mistaken for an attribute or a tag end.

type Attr = { name: string; valStart: number; valEnd: number; raw: string }
type Tok = {
  kind: "parameter" | "parameters-open" | "parameters-close"
  start: number
  end: number
  attrsEnd: number
  selfClosing: boolean
  attrs: Attr[]
}

const MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)/g
const ATTR_RE = /\s+([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
const TAIL_RE = /\s*(\/?)>/y

function tokenize(xml: string): Tok[] {
  const toks: Tok[] = []
  MARKUP.lastIndex = 0
  for (let m = MARKUP.exec(xml); m; m = MARKUP.exec(xml)) {
    if (m[2] === undefined) continue // comment / CDATA / PI: skipped whole
    const name = m[2]
    const start = m.index
    if (m[1]) {
      const c = /\s*>/y
      c.lastIndex = MARKUP.lastIndex
      if (name === "parameters" && c.test(xml)) {
        toks.push({ kind: "parameters-close", start, end: c.lastIndex, attrsEnd: start, selfClosing: false, attrs: [] })
      }
      continue
    }
    const attrs: Attr[] = []
    let pos = MARKUP.lastIndex
    for (;;) {
      ATTR_RE.lastIndex = pos
      const a = ATTR_RE.exec(xml)
      if (!a) break
      const raw = a[2] ?? a[3]
      const valEnd = ATTR_RE.lastIndex - 1
      attrs.push({ name: a[1], valStart: valEnd - raw.length, valEnd, raw })
      pos = ATTR_RE.lastIndex
    }
    TAIL_RE.lastIndex = pos
    const t = TAIL_RE.exec(xml)
    if (!t) continue // malformed tag: validateXml reports it
    MARKUP.lastIndex = TAIL_RE.lastIndex
    if (name === "parameter" || name === "parameters") {
      toks.push({
        kind: name === "parameter" ? "parameter" : "parameters-open",
        start,
        end: TAIL_RE.lastIndex,
        attrsEnd: pos,
        selfClosing: t[1] === "/",
        attrs,
      })
    }
  }
  return toks
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
function decode(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, d, h, n) => {
    if (n) return NAMED[n]
    const cp = d !== undefined ? Number(d) : parseInt(h, 16)
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  })
}

function escAttr(v: string, quote: string): string {
  const s = v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;")
  return quote === "'" ? s.replace(/'/g, "&apos;") : s.replace(/"/g, "&quot;")
}

const attr = (t: Tok, n: string): Attr | undefined => t.attrs.find((a) => a.name === n)

/** Reads `<parameter name value>` pairs (entities decoded, values untrimmed). With duplicate names the first wins. */
export function readParams(xml: string): Record<string, string> {
  // Null prototype + hasOwn so names like `constructor` / `toString` / `__proto__` are ordinary keys.
  const out: Record<string, string> = Object.create(null)
  for (const t of tokenize(xml)) {
    if (t.kind !== "parameter") continue
    const n = attr(t, "name")
    if (!n) continue
    const name = decode(n.raw)
    if (!Object.hasOwn(out, name)) out[name] = decode(attr(t, "value")?.raw ?? "")
  }
  return out
}

export function validateXml(xml: string): { ok: true } | { ok: false; line: number; message: string } {
  const r = XMLValidator.validate(xml)
  if (r === true) return { ok: true }
  return { ok: false, line: r.err.line, message: r.err.msg }
}

type Edit = { start: number; end: number; text: string }

/**
 * Sets the `value` attribute of every live `<parameter name="X">` by editing the text in place (no
 * re-serialisation, every other byte untouched). Missing keys are appended inside `<parameters>`.
 */
export function setParams(xml: string, changes: Record<string, string>): string {
  const toks = tokenize(xml)
  const pending = new Set(Object.keys(changes))
  const edits: Edit[] = []
  for (const t of toks) {
    if (t.kind !== "parameter") continue
    const n = attr(t, "name")
    const name = n ? decode(n.raw) : undefined
    if (name === undefined || !Object.hasOwn(changes, name)) continue
    pending.delete(name)
    const v = attr(t, "value")
    if (v) {
      const q = xml[v.valStart - 1]
      edits.push({ start: v.valStart, end: v.valEnd, text: escAttr(changes[name], q) })
    } else {
      edits.push({ start: t.attrsEnd, end: t.attrsEnd, text: ` value="${escAttr(changes[name], '"')}"` })
    }
  }

  if (pending.size > 0) {
    const els = [...pending].map((k) => `<parameter name="${escAttr(k, '"')}" value="${escAttr(changes[k], '"')}"/>`)
    const close = toks.findLast((t) => t.kind === "parameters-close")
    const open = toks.findLast((t) => t.kind === "parameters-open")
    if (close) {
      const lineStart = xml.lastIndexOf("\n", close.start - 1) + 1
      const own = /^[ \t]*$/.test(xml.slice(lineStart, close.start))
      const prev = toks.findLast((t) => t.kind === "parameter" && t.start < close.start)
      const pls = prev ? xml.lastIndexOf("\n", prev.start - 1) + 1 : 0
      const seg = prev ? xml.slice(pls, prev.start) : ""
      const lineIndent = prev && /^[ \t]*$/.test(seg) ? seg : "  "
      const text = own ? els.map((e) => `${lineIndent}${e}\n`).join("") : els.join("")
      const at = own ? lineStart : close.start
      edits.push({ start: at, end: at, text })
    } else if (open?.selfClosing) {
      const lineStart = xml.lastIndexOf("\n", open.start - 1) + 1
      const base = /^[ \t]*/.exec(xml.slice(lineStart, open.start))![0]
      const tail = xml.slice(open.start, open.end).replace(/\s*\/>$/, ">")
      edits.push({
        start: open.start,
        end: open.end,
        text: `${tail}\n${els.map((e) => `${base}  ${e}\n`).join("")}${base}</parameters>`,
      })
    } else {
      throw new MidError(
        "invalid_request",
        400,
        "config.xml ไม่มี element <parameters> จึงเพิ่มค่าพารามิเตอร์ไม่ได้ ตรวจสอบไฟล์แล้วลองใหม่",
      )
    }
  }

  let out = xml
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
