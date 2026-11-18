import { describe, expect, it } from "vitest"
import { makeSystemctl, mapExecResult, parseActiveMidUnits, parseEnabledMidUnits } from "./systemctl"

const FIXTURE = `midhub-mid-a1.service     loaded active   running MidHub MID Server
midhub-mid-b2.service     loaded activating start   MidHub MID Server
midhub-mid-c3.service     loaded reloading  reload  MidHub MID Server
midhub-mid-g7.service     loaded deactivating stop MidHub MID Server
midhub-mid-d4.service     loaded inactive   dead    MidHub MID Server
● midhub-mid-e5.service   loaded failed     failed  MidHub MID Server
midhub-mid-f6.service     not-found inactive dead   midhub-mid-f6.service
other.service             loaded active   running Other
midhub-mid-../x.service   loaded active   running bogus

garbage
`
describe("parseActiveMidUnits", () => {
  it("counts active, activating and reloading midhub units only", () => {
    expect(parseActiveMidUnits(FIXTURE)).toEqual(["midhub-mid-a1.service", "midhub-mid-b2.service", "midhub-mid-c3.service", "midhub-mid-g7.service"])
  })
  it("handles empty output", () => expect(parseActiveMidUnits("")).toEqual([]))
})

describe("parseEnabledMidUnits", () => {
  it("parses list-unit-files output", () => {
    const out = "midhub-mid-a1.service enabled enabled\nmidhub-mid-b2.service enabled-runtime enabled\nother.service enabled enabled\nmidhub-mid-../x.service enabled enabled\n"
    expect(parseEnabledMidUnits(out)).toEqual(["midhub-mid-a1.service"])
    expect(parseEnabledMidUnits("")).toEqual([])
  })
})

describe("makeSystemctl list commands", () => {
  const mk = (code: number, stdout: string) => makeSystemctl(async () => ({ code, stdout }))
  it("exit 1 with empty output (nothing matches) -> []", async () => {
    expect(await mk(1, "").enabledMidUnits()).toEqual([])
    expect(await mk(1, "0 unit files listed.\n").enabledMidUnits()).toEqual([])
    expect(await mk(1, "").activeMidUnits()).toEqual([])
  })
  it("exit 1 with a real error, or other codes, throw", async () => {
    await expect(mk(1, "some real error").enabledMidUnits()).rejects.toThrow()
    await expect(mk(1, "some real error").activeMidUnits()).rejects.toThrow()
    await expect(mk(4, "").enabledMidUnits()).rejects.toThrow()
  })
  it("non-numeric failure (code -1) throws for both commands", async () => {
    await expect(mk(-1, "").enabledMidUnits()).rejects.toThrow()
    await expect(mk(-1, "").activeMidUnits()).rejects.toThrow()
  })
  it("exit 0 parses output", async () => {
    expect(await mk(0, "midhub-mid-a1.service enabled enabled\n").enabledMidUnits()).toEqual(["midhub-mid-a1.service"])
  })
})

describe("mapExecResult", () => {
  it("keeps numeric exit codes", () => {
    expect(mapExecResult(null, "o", "e")).toEqual({ code: 0, stdout: "oe" })
    expect(mapExecResult(Object.assign(new Error("x"), { code: 1 }), "", "")).toEqual({ code: 1, stdout: "" })
  })
  it("maps timeout, spawn and maxBuffer errors to -1 with the cause", () => {
    const killed = mapExecResult(Object.assign(new Error("t"), { code: null, killed: true, signal: "SIGTERM" }), "", "")
    expect(killed.code).toBe(-1)
    expect(killed.stdout).toContain("SIGTERM")
    expect(mapExecResult(Object.assign(new Error("s"), { code: "ENOENT" }), "", "")).toMatchObject({ code: -1 })
    expect(mapExecResult(Object.assign(new Error("s"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "", "").stdout).toContain("MAXBUFFER")
  })
})
