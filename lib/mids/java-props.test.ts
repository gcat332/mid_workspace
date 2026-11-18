import { describe, expect, it } from "vitest"
import { readProp, setProp } from "./java-props"

describe("readProp", () => {
  it("reads =, :, whitespace separators and trims", () => {
    expect(readProp("a=1\n", "a")).toBe("1")
    expect(readProp("a = 1 \n", "a")).toBe("1")
    expect(readProp("a:1\n", "a")).toBe("1")
    expect(readProp("a : 1\n", "a")).toBe("1")
    expect(readProp("a   1\n", "a")).toBe("1")
    expect(readProp("a\t1\r\n", "a")).toBe("1")
  })
  it("returns null when absent, commented, or only a prefix match", () => {
    expect(readProp("b=1\n", "a")).toBeNull()
    expect(readProp("#a=1\n!a=2\n", "a")).toBeNull()
    expect(readProp("ab=1\n", "a")).toBeNull()
  })
  it("uses the first non-comment occurrence", () => {
    expect(readProp("#a=0\na=1\na=2\n", "a")).toBe("1")
  })
})

describe("setProp", () => {
  it("replaces an existing key keeping other bytes", () => {
    const t = "x=1\n# c\na=old\ny=2"
    expect(setProp(t, "a", "new")).toBe("x=1\n# c\na=new\ny=2")
  })
  it("does not treat a commented key as the key", () => {
    expect(setProp("#a=10\n", "a", "3")).toBe("#a=10\na=3\n")
    expect(setProp("!a=10\n", "a", "3")).toBe("!a=10\na=3\n")
  })
  it("appends when absent, adding a newline if missing", () => {
    expect(setProp("x=1", "a", "3")).toBe("x=1\na=3\n")
    expect(setProp("", "a", "3")).toBe("a=3\n")
  })
  it("keeps CRLF", () => {
    expect(setProp("x=1\r\na=2\r\n", "a", "3")).toBe("x=1\r\na=3\r\n")
    expect(setProp("x=1\r\n", "a", "3")).toBe("x=1\r\na=3\r\n")
  })
  it("replaces key = value with spaces", () => {
    expect(setProp("a = 1\nb=2\n", "a", "9")).toBe("a=9\nb=2\n")
  })
  it("replaces key:value", () => {
    expect(setProp("a:1\nb=2\n", "a", "9")).toBe("a=9\nb=2\n")
  })
  it("replaces whitespace-separated key", () => {
    expect(setProp("a   1\nb=2\n", "a", "9")).toBe("a=9\nb=2\n")
  })
  it("does not match a longer key with the same prefix", () => {
    expect(setProp("ab=1\n", "a", "9")).toBe("ab=1\na=9\n")
  })
  it("replaces only the first occurrence", () => {
    expect(setProp("a=1\na=2\n", "a", "9")).toBe("a=9\na=2\n")
  })
  it("handles indented keys", () => {
    expect(setProp("  a=1\n", "a", "9")).toBe("a=9\n")
  })
  it("leaves an unrelated continuation untouched when setting another key", () => {
    const t = "x=1 \\\n  a=2 \\\n  more\nb=3\n"
    expect(setProp(t, "b", "9")).toBe("x=1 \\\n  a=2 \\\n  more\nb=9\n")
  })
  it("does not match a key inside a continuation", () => {
    const t = "x=1 \\\n  a=2\n"
    expect(setProp(t, "a", "9")).toBe(t + "a=9\n")
    expect(readProp(t, "a")).toBeNull()
  })
  it("throws when the key itself spans lines, changing nothing", () => {
    const t = "a=1 \\\n  2\n"
    expect(() => setProp(t, "a", "9")).toThrowError(
      expect.objectContaining({ code: "invalid_request", detail: "property a spans multiple lines" }),
    )
  })
  it("rejects invalid keys and values", () => {
    for (const [k, v] of [["a b", "1"], ["a=b", "1"], ["", "1"], ["a\n", "1"], ["a", "1\n2"], ["a", "1\r"], ["a", "1\0"], ["a", "x\\"], ["a", "x\\\\\\"]]) {
      expect(() => setProp("", k, v)).toThrowError(expect.objectContaining({ code: "invalid_request" }))
    }
    expect(setProp("", "a", "x\\\\")).toBe("a=x\\\\\n")
  })
})

describe("readProp continuation", () => {
  it("joins continuation lines stripping leading whitespace", () => {
    expect(readProp("a=one \\\n    two\\\n  three\nb=1\n", "a")).toBe("one two" + "three")
    expect(readProp("a=one,\\\r\n   two\r\n", "a")).toBe("one,two")
  })
})
