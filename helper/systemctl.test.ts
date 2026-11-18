import { describe, expect, it } from "vitest"
import { parseActiveMidUnits, parseEnabledMidUnits } from "./systemctl"

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
