import { describe, expect, it } from "vitest"
import { parseMeminfo, parseSystemctlShow, parseSystemdTimestamp, readServiceStatus } from "./status"

const show = (active: string, sub: string, extra = "") =>
  `ActiveState=${active}\nSubState=${sub}\nMainPID=4242\nMemoryCurrent=1048576\nActiveEnterTimestamp=Wed 2026-11-18 19:07:57 +07\n${extra}`

describe("parseSystemctlShow", () => {
  it("active/running -> running with pid, memory and since", () => {
    const s = parseSystemctlShow(show("active", "running"))
    expect(s).toEqual({ state: "running", pid: 4242, memoryBytes: 1048576, since: new Date("2026-11-18T12:07:57Z") })
  })
  it("maps the other ActiveStates", () => {
    expect(parseSystemctlShow(show("inactive", "dead")).state).toBe("stopped")
    expect(parseSystemctlShow(show("failed", "failed")).state).toBe("failed")
    expect(parseSystemctlShow(show("activating", "start")).state).toBe("starting")
    expect(parseSystemctlShow(show("reloading", "reload")).state).toBe("running")
    expect(parseSystemctlShow(show("deactivating", "stop-sigterm")).state).toBe("running")
    expect(parseSystemctlShow(show("weird", "x")).state).toBe("unknown")
    expect(parseSystemctlShow("").state).toBe("unknown")
  })
  it("[not set] memory, uint64-max memory and MainPID=0 -> null; empty/n-a timestamp -> null since", () => {
    const s = parseSystemctlShow("ActiveState=inactive\nSubState=dead\nMainPID=0\nMemoryCurrent=[not set]\nActiveEnterTimestamp=\n")
    expect(s).toEqual({ state: "stopped", pid: null, memoryBytes: null, since: null })
    expect(parseSystemctlShow("ActiveState=active\nMemoryCurrent=18446744073709551615\nActiveEnterTimestamp=n/a\n")).toMatchObject({ memoryBytes: null, since: null })
  })
})

describe("parseSystemdTimestamp", () => {
  it("parses numeric offsets in several spellings", () => {
    const want = new Date("2026-11-18T12:07:57Z")
    expect(parseSystemdTimestamp("Wed 2026-11-18 19:07:57 +07")).toEqual(want)
    expect(parseSystemdTimestamp("Wed 2026-11-18 19:07:57 +0700")).toEqual(want)
    expect(parseSystemdTimestamp("Wed 2026-11-18 19:07:57 +07:00")).toEqual(want)
    expect(parseSystemdTimestamp("2026-11-18 19:07:57.123456 +07")).toEqual(want)
    expect(parseSystemdTimestamp("Wed 2026-11-18 05:07:57 -0700")).toEqual(want)
  })
  it("parses UTC", () => {
    expect(parseSystemdTimestamp("Wed 2026-11-18 12:07:57 UTC")).toEqual(new Date("2026-11-18T12:07:57Z"))
  })
  it("reads an unknown zone abbreviation as host-local time", () => {
    expect(parseSystemdTimestamp("Wed 2026-11-18 19:07:57 ICT")).toEqual(new Date(2026, 10, 18, 19, 7, 57))
  })
  it("returns null for empty, n/a and garbage", () => {
    for (const v of ["", "n/a", undefined, "yesterday", "Wed 2026-13-45 99:99:99 +07"]) expect(parseSystemdTimestamp(v)).toBeNull()
  })
})

describe("parseMeminfo", () => {
  it("converts kB to bytes", () => {
    const text = "MemTotal:        8192000 kB\nMemFree:          100000 kB\nMemAvailable:    4096000 kB\nBuffers: 1 kB\n"
    expect(parseMeminfo(text)).toEqual({ totalBytes: 8192000 * 1024, availableBytes: 4096000 * 1024 })
  })
  it("throws when a field is missing", () => {
    expect(() => parseMeminfo("MemTotal: 1 kB\n")).toThrow(/MemAvailable/)
  })
})

describe("readServiceStatus", () => {
  it("validates the name before running anything", async () => {
    await expect(readServiceStatus("../etc")).rejects.toMatchObject({ code: "invalid_name" })
  })
})
