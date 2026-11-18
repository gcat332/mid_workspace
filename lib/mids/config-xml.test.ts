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
