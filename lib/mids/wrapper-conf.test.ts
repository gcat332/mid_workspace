import { describe, expect, it } from "vitest"
import { readHeapMb, setHeapMb } from "./wrapper-conf"

const CONF = `# override\nwrapper.java.additional.1=-Dx=1\nwrapper.java.maxmemory=1024\nwrapper.foo=bar\n`

describe("wrapper conf heap", () => {
  it("reads 1024", () => expect(readHeapMb(CONF)).toBe(1024))
  it("returns null when absent or commented", () => {
    expect(readHeapMb("a=b\n")).toBeNull()
    expect(readHeapMb("#wrapper.java.maxmemory=512\n")).toBeNull()
  })
  it("replaces the existing line only", () => {
    expect(setHeapMb(CONF, 2048)).toBe(CONF.replace("=1024", "=2048"))
  })
  it("adds the line if absent, keeping newline handling", () => {
    expect(setHeapMb("a=b\n", 2048)).toBe("a=b\nwrapper.java.maxmemory=2048\n")
    expect(setHeapMb("a=b", 2048)).toBe("a=b\nwrapper.java.maxmemory=2048\n")
    expect(setHeapMb("", 2048)).toBe("wrapper.java.maxmemory=2048\n")
  })
})

describe("wrapper conf CRLF", () => {
  const CRLF = "a=b\r\nwrapper.java.maxmemory=1024\r\nc=d\r\n"
  it("reads and replaces without touching line endings or duplicating", () => {
    expect(readHeapMb(CRLF)).toBe(1024)
    expect(setHeapMb(CRLF, 2048)).toBe("a=b\r\nwrapper.java.maxmemory=2048\r\nc=d\r\n")
  })
  it("appends with CRLF when the file uses CRLF", () => {
    expect(setHeapMb("a=b\r\n", 2048)).toBe("a=b\r\nwrapper.java.maxmemory=2048\r\n")
  })
})
