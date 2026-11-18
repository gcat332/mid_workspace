import { describe, expect, it } from "vitest"
import { parseActiveMidUnits } from "./systemctl"

const FIXTURE = `midhub-mid-a1.service     loaded active   running MidHub MID Server
midhub-mid-b2.service     loaded activating start   MidHub MID Server
midhub-mid-c3.service     loaded reloading  reload  MidHub MID Server
midhub-mid-d4.service     loaded inactive   dead    MidHub MID Server
● midhub-mid-e5.service   loaded failed     failed  MidHub MID Server
midhub-mid-f6.service     not-found inactive dead   midhub-mid-f6.service
other.service             loaded active   running Other
midhub-mid-../x.service   loaded active   running bogus

garbage
`
describe("parseActiveMidUnits", () => {
  it("counts active, activating and reloading midhub units only", () => {
    expect(parseActiveMidUnits(FIXTURE)).toEqual(["midhub-mid-a1.service", "midhub-mid-b2.service", "midhub-mid-c3.service"])
  })
  it("handles empty output", () => expect(parseActiveMidUnits("")).toEqual([]))
})
