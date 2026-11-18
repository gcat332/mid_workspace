import { describe, expect, it } from "vitest"
import { readParams, setParams, validateXml } from "./config-xml"

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- MID config -->
<parameters>
  <!-- <parameter name="url" value="https://commented.service-now.com/"/> -->
  <parameter name="url" value="https://old.service-now.com/"/>
  <parameter value="mid-one" name="name"/>
  <parameter name="mid.instance.username" value='svc_mid' />
  <parameter name="mid.instance.password" secure="true" value="ENC(abc==)"></parameter>
  <parameter name="threads.max" value="25"/>
</parameters>
`

describe("readParams", () => {
  it("reads url/name/username regardless of attribute order and quotes, ignoring comments", () => {
    const p = readParams(XML)
    expect(p.url).toBe("https://old.service-now.com/")
    expect(p.name).toBe("mid-one")
    expect(p["mid.instance.username"]).toBe("svc_mid")
    expect(p["mid.instance.password"]).toBe("ENC(abc==)")
  })
  it("handles a single parameter", () => {
    expect(readParams(`<parameters><parameter name="a" value="1"/></parameters>`)).toEqual({ a: "1" })
  })
  it("returns {} with no parameters", () => {
    expect(readParams(`<parameters/>`)).toEqual({})
  })
})

describe("setParams", () => {
  it("changes only the one attribute: diff is exactly one line", () => {
    const out = setParams(XML, { url: "https://a.service-now.com/" })
    const a = XML.split("\n")
    const b = out.split("\n")
    expect(b.length).toBe(a.length)
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y)
    expect(diff).toEqual([[`  <parameter name="url" value="https://old.service-now.com/"/>`, `  <parameter name="url" value="https://a.service-now.com/"/>`]])
  })
  it("handles value-first order, single quotes and non-self-closing elements", () => {
    const out = setParams(XML, { name: "mid-two", "mid.instance.username": "bob", "mid.instance.password": "x" })
    expect(out).toContain(`<parameter value="mid-two" name="name"/>`)
    expect(out).toContain(`<parameter name="mid.instance.username" value='bob' />`)
    expect(out).toContain(`<parameter name="mid.instance.password" secure="true" value="x"></parameter>`)
  })
  it("escapes XML specials", () => {
    const out = setParams(XML, { "threads.max": `a&b"<` })
    expect(out).toContain(`value="a&amp;b&quot;&lt;"`)
    expect(readParams(out)["threads.max"]).toBe(`a&b"<`)
  })
  it("escapes the apostrophe inside single-quoted values", () => {
    const out = setParams(XML, { "mid.instance.username": "o'x" })
    expect(readParams(out)["mid.instance.username"]).toBe("o'x")
  })
  it("never edits a commented-out parameter", () => {
    const out = setParams(XML, { url: "https://n/" })
    expect(out).toContain(`<!-- <parameter name="url" value="https://commented.service-now.com/"/> -->`)
  })
  it("appends an unknown key before </parameters>, matching indentation", () => {
    const out = setParams(XML, { "new.key": "v" })
    expect(out).toContain(`  <parameter name="threads.max" value="25"/>\n  <parameter name="new.key" value="v"/>\n</parameters>`)
    expect(readParams(out)["new.key"]).toBe("v")
  })
  it("returns the input unchanged for no changes and throws without </parameters> when appending", () => {
    expect(setParams(XML, {})).toBe(XML)
    expect(() => setParams("<x/>", { a: "1" })).toThrow()
  })
})

describe("tokenizer edge cases", () => {
  it("does not read attributes out of a quoted value (exact repro)", () => {
    const x = `<parameters><parameter value='say name="zz"' name="a"/></parameters>`
    expect(readParams(x)).toEqual({ a: `say name="zz"` })
    const out = setParams(x, { a: "1", zz: "q" })
    expect(readParams(out)).toEqual({ a: "1", zz: "q" })
    expect(out.match(/name="a"/g)).toHaveLength(1)
  })
  it("distinguishes prefix names (url vs url.proxy)", () => {
    const x = `<parameters><parameter name="url.proxy" value="p"/><parameter name="url" value="u"/></parameters>`
    const out = setParams(x, { url: "new" })
    expect(readParams(out)).toEqual({ "url.proxy": "p", url: "new" })
  })
  it("handles values containing /> and >", () => {
    const x = `<parameters><parameter name="a" value="x/>y>z"/><parameter name="b" value="1"/></parameters>`
    expect(readParams(x)).toEqual({ a: "x/>y>z", b: "1" })
    expect(readParams(setParams(x, { b: "2" }))).toEqual({ a: "x/>y>z", b: "2" })
  })
  it("edits all duplicate live names; read returns the first", () => {
    const x = `<parameters><parameter name="a" value="1"/><parameter name="a" value="2"/></parameters>`
    expect(readParams(x).a).toBe("1")
    const out = setParams(x, { a: "9" })
    expect(out).toBe(`<parameters><parameter name="a" value="9"/><parameter name="a" value="9"/></parameters>`)
  })
  it("decodes entity-encoded names and numeric refs, and does not trim values", () => {
    const x = `<parameters><parameter name="n&amp;m" value=" a&#10;b&#x41; "/></parameters>`
    expect(readParams(x)).toEqual({ "n&m": " a\nbA " })
    expect(setParams(x, { "n&m": "z" })).toBe(`<parameters><parameter name="n&amp;m" value="z"/></parameters>`)
  })
  it("expands an empty <parameters/> when appending, and throws without any <parameters>", () => {
    const out = setParams(`<parameters/>\n`, { a: "1" })
    expect(out).toBe(`<parameters>\n  <parameter name="a" value="1"/>\n</parameters>\n`)
    expect(validateXml(out)).toEqual({ ok: true })
    expect(() => setParams("<x/>", { a: "1" })).toThrow(/parameters/)
  })
  it("round-trips tricky values", () => {
    for (const v of ["a&b", `q"uote`, "it's", "<tag>", "/>", `name="x"`, "line1\nline2", "tab\there", "cr\r\n", "&amp;", ""]) {
      for (const base of [XML, `<parameters/>`, `<parameters><parameter name="k" value='z'/></parameters>`]) {
        const out = setParams(base, { k: v, "new.key": v })
        const r = readParams(out)
        expect(r.k).toBe(v)
        expect(r["new.key"]).toBe(v)
        expect(validateXml(out)).toEqual({ ok: true })
      }
    }
  })
})

describe("validateXml", () => {
  it("ok for valid xml", () => expect(validateXml(XML)).toEqual({ ok: true }))
  it("reports a line number for broken xml", () => {
    const r = validateXml("<parameters>\n<parameter name='a'>\n")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.line).toBeGreaterThan(0)
      expect(r.message).toBeTruthy()
    }
  })
})
