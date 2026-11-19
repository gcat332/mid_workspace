import { describe, expect, it } from "vitest"
import { BUILDSTAMP_RE as SERVER_RE } from "@/lib/mids/buildstamp"
import { SN_NAME_RE as SERVER_SN } from "@/lib/jobs/lifecycle"
import { MIN_FREE_BYTES as SERVER_MIN_FREE } from "@/lib/mids/layout"
import { BUILDSTAMP_RE, SN_NAME_RE, canProceed, deriveNameCheck, effectiveBuildstamp, jobStageLabel, parseProgress, reviewChecks, type WizardState } from "./wizard"

const GOOD = "washingtondc-12-08-2023__patch5-hotfix1-02-14-2024_02-23-2024_1115"
const base: WizardState = {
  instance: { id: "i1", hasPassword: true, buildstamp: GOOD },
  pendingNew: false,
  buildstamp: "",
  name: "mid-a", nameCheck: "available", snName: "midhub-mid-a",
  heapMb: "1024", logFiles: "3",
  proxyOn: false, proxyHost: "", proxyPort: "",
}
const s = (p: Partial<WizardState>): WizardState => ({ ...base, ...p })

describe("BUILDSTAMP_RE duplicate", () => {
  it("matches the server regex on the same samples", () => {
    const samples = [GOOD, "xanadu-12-08-2024_01-02-2025_0900", "nope", "washingtondc-12-08-2023_02-23-2024", "", GOOD + "x", " " + GOOD, "a-1-1-1_1-1-1_1"]
    for (const x of samples) expect(BUILDSTAMP_RE.test(x), x).toBe(SERVER_RE.test(x))
  })
})

describe("canProceed", () => {
  it("step 1 needs a selected instance", () => {
    const r = canProceed(1, s({ instance: null }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/instance/)
  })
  it("step 1 blocks an unsaved/untested new instance", () => {
    const r = canProceed(1, s({ instance: null, pendingNew: true }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Test and Save/)
  })
  it("step 1 blocks an instance without credentials", () => {
    const r = canProceed(1, s({ instance: { id: "i1", hasPassword: false, buildstamp: GOOD } }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/รหัส/)
  })
  it("step 1 needs a valid buildstamp when the instance has none", () => {
    const inst = { id: "i1", hasPassword: true, buildstamp: null }
    expect(canProceed(1, s({ instance: inst })).ok).toBe(false)
    expect(canProceed(1, s({ instance: inst, buildstamp: "bad" })).reason).toMatch(/build/i)
    expect(canProceed(1, s({ instance: inst, buildstamp: GOOD })).ok).toBe(true)
  })
  it("step 1 passes with a credentialed instance that has a build", () => {
    expect(canProceed(1, base)).toEqual({ ok: true })
  })
  it("step 2: taken / checking / invalid name block", () => {
    expect(canProceed(2, s({ nameCheck: "taken" })).ok).toBe(false)
    expect(canProceed(2, s({ nameCheck: "checking" })).ok).toBe(false)
    expect(canProceed(2, s({ name: "", nameCheck: "idle" })).reason).toMatch(/ชื่อ/)
    expect(canProceed(2, s({ name: "A!", nameCheck: "idle" })).ok).toBe(false)
  })
  it("step 2: logFiles 0 and heap out of range block", () => {
    expect(canProceed(2, s({ logFiles: "0" })).ok).toBe(false)
    expect(canProceed(2, s({ logFiles: "11" })).ok).toBe(false)
    expect(canProceed(2, s({ logFiles: "1.5" })).ok).toBe(false)
    expect(canProceed(2, s({ heapMb: "100" })).ok).toBe(false)
    expect(canProceed(2, s({ heapMb: "9000" })).ok).toBe(false)
    expect(canProceed(2, s({ heapMb: "" })).ok).toBe(false)
  })
  it("step 2: snName must be valid", () => {
    expect(canProceed(2, s({ snName: "bad name" })).ok).toBe(false)
    expect(canProceed(2, s({ snName: "" })).ok).toBe(false)
  })
  it("step 2: proxy needs host and port when on", () => {
    expect(canProceed(2, s({ proxyOn: true })).ok).toBe(false)
    expect(canProceed(2, s({ proxyOn: true, proxyHost: "px.corp", proxyPort: "99999" })).ok).toBe(false)
    expect(canProceed(2, s({ proxyOn: true, proxyHost: "px.corp", proxyPort: "8080" })).ok).toBe(true)
  })
  it("step 2 passes by default", () => expect(canProceed(2, base)).toEqual({ ok: true }))
})

const GIB = 1024 ** 3
describe("reviewChecks", () => {
  const host = { totalBytes: 8 * GIB, availableBytes: 4 * GIB, running: 0, quotaUsed: 0, maxRunning: 3, disk: { freeBytes: 10 * GIB, totalBytes: 50 * GIB, usage: null } }
  it("ok when all good, canProceed(3) true", () => {
    const c = reviewChecks(host)
    expect(c.every((x) => x.level === "ok")).toBe(true)
    expect(canProceed(3, base, c).ok).toBe(true)
  })
  it("disk under 2 GB blocks", () => {
    const c = reviewChecks({ ...host, disk: { freeBytes: 1 * GIB, totalBytes: null, usage: null } })
    expect(c.find((x) => x.level === "block")).toBeTruthy()
    expect(canProceed(3, base, c).ok).toBe(false)
    expect(canProceed(3, base, c).reason).toMatch(/ดิสก์/)
  })
  it("quota full warns with the start hint but does not block", () => {
    const c = reviewChecks({ ...host, quotaUsed: 3 })
    const w = c.find((x) => x.level === "warn")
    expect(w?.text).toContain("จะติดตั้งได้ แต่ start ไม่ได้จนกว่าจะหยุดตัวอื่น")
    expect(canProceed(3, base, c).ok).toBe(true)
  })
  it("RAM under 1 GiB warns", () => {
    expect(reviewChecks({ ...host, availableBytes: GIB / 2 }).some((x) => x.level === "warn")).toBe(true)
  })
  it("unknown host info warns instead of passing silently, and blocks nothing", () => {
    const c = reviewChecks(null)
    expect(c.some((x) => x.level === "block")).toBe(false)
    expect(c.some((x) => x.level === "warn")).toBe(true)
  })
})

describe("misc helpers", () => {
  it("effectiveBuildstamp prefers instance build", () => {
    expect(effectiveBuildstamp(base)).toBe(GOOD)
    expect(effectiveBuildstamp(s({ instance: { id: "i", hasPassword: true, buildstamp: null }, buildstamp: " x " }))).toBe("x")
  })
  it("parseProgress reads the last download percent", () => {
    expect(parseProgress(["ดาวน์โหลด package 10%", "other", "ดาวน์โหลด package 42%"])).toBe(42)
    expect(parseProgress(["x"])).toBeNull()
  })
  it("jobStageLabel maps known stages and falls back to the raw name", () => {
    expect(jobStageLabel("fetchPackage")).toBe("Download Package")
    expect(jobStageLabel("weird")).toBe("weird")
  })
})

describe("deriveNameCheck", () => {
  it("covers idle, invalid, checking, and answers only for the same name", () => {
    expect(deriveNameCheck("", null)).toBe("idle")
    expect(deriveNameCheck("A!", null)).toBe("invalid")
    expect(deriveNameCheck("mid-a", null)).toBe("checking")
    expect(deriveNameCheck("mid-a", { name: "mid-a", status: "available" })).toBe("available")
    expect(deriveNameCheck("mid-a", { name: "mid-a", status: "taken" })).toBe("taken")
    expect(deriveNameCheck("mid-a", { name: "mid-a", status: "error" })).toBe("error")
    expect(deriveNameCheck("mid-ab", { name: "mid-a", status: "available" })).toBe("checking")
    expect(deriveNameCheck("", { name: "mid-a", status: "available" })).toBe("idle")
  })
})

describe("shared constants agree with the server", () => {
  it("SN_NAME_RE accepts and rejects the same samples", () => {
    for (const x of ["midhub-a", "a.b_c-1", "", "a b", "x".repeat(80), "x".repeat(81), "ไทย", "a/b"]) expect(SN_NAME_RE.test(x), x).toBe(SERVER_SN.test(x))
  })
  it("disk threshold is the server's MIN_FREE_BYTES", () => {
    const host = { totalBytes: 1, availableBytes: 4 * GIB, running: 0, quotaUsed: 0, maxRunning: 3 }
    const just = (b: number) => reviewChecks({ ...host, disk: { freeBytes: b, totalBytes: null, usage: null } }).some((c) => c.level === "block")
    expect(just(SERVER_MIN_FREE - 1)).toBe(true)
    expect(just(SERVER_MIN_FREE)).toBe(false)
  })
})
