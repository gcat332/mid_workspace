import { describe, expect, it } from "vitest"
import { resumableUninstall, failedJobShown, formatBytes, formatJobTime, formatUptime, jobIsActive, quotaView, statusView, type MidView } from "./status-view"

const mid = (state: string, st: MidView["status"]["state"]): MidView => ({
  name: "m1", instanceUrl: null, midName: null, heapMb: 1024, version: null, state,
  status: { state: st, pid: null, memoryBytes: null, since: null },
})

describe("statusView", () => {
  it.each([
    ["ready", "running", "🟢", "กำลังรัน"],
    ["ready", "stopped", "⚪", "หยุด"],
    ["ready", "starting", "🟡", "กำลังทำงาน"],
    ["ready", "failed", "🔴", "ล่ม"],
    ["ready", "unknown", "⚪", "ไม่ทราบสถานะ"],
    ["installing", "stopped", "🟡", "กำลังทำงาน"],
    ["upgrading", "running", "🟡", "กำลังทำงาน"],
    ["uninstalling", "stopped", "🟡", "กำลังทำงาน"],
    ["error", "stopped", "🔴", "ล่ม"],
  ])("state=%s status=%s", (state, st, icon, label) => {
    expect(statusView(mid(state, st as MidView["status"]["state"]))).toEqual({ icon, label })
  })
})

const withJob = (state: string, job: NonNullable<MidView["job"]>, st: MidView["status"]["state"] = "stopped"): MidView => ({ ...mid(state, st), job })
const J = (kind: string, stage: string, status: string) => ({ id: "j1", kind, stage, status, createdAt: "2026-11-18T05:00:00.000Z" })

describe("statusView with a job", () => {
  it.each([
    ["install", "fetchPackage", "กำลังดาวน์โหลด"],
    ["install", "extract", "กำลังแตกไฟล์"],
    ["clone", "configure", "กำลังตั้งค่า"],
    ["install", "waitConnected", "รอเชื่อมต่อ instance"],
    ["install", "precheck", "กำลังติดตั้ง"],
    ["uninstall", "stop", "กำลังลบ"],
    ["uninstall", "archive", "กำลังลบ"],
    ["cancel_install", "deleteDir", "กำลังลบ"],
  ])("running %s/%s -> yellow %s", (kind, stage, label) => {
    expect(statusView(withJob("installing", J(kind, stage, "running")))).toEqual({ icon: "🟡", label })
  })
  it("queued counts as active; an active job beats a running service", () => {
    expect(statusView(withJob("installed", J("install", "extract", "queued"), "running"))).toEqual({ icon: "🟡", label: "กำลังแตกไฟล์" })
  })
  it("failed install -> red 'ติดตั้งไม่สำเร็จ' while the MID is not installed", () => {
    expect(statusView(withJob("error", J("install", "extract", "failed")))).toEqual({ icon: "🔴", label: "ติดตั้งไม่สำเร็จ" })
    expect(statusView(withJob("installing", J("clone", "extract", "failed")))).toEqual({ icon: "🔴", label: "ติดตั้งไม่สำเร็จ" })
  })
  it("cancel_install: running -> กำลังลบ, failed -> ลบไม่สำเร็จ", () => {
    expect(statusView(withJob("installing", J("cancel_install", "stop", "running")))).toEqual({ icon: "🟡", label: "กำลังลบ" })
    expect(statusView(withJob("error", J("cancel_install", "stop", "failed")))).toEqual({ icon: "🔴", label: "ลบไม่สำเร็จ" })
  })
  it("failed removal -> red 'ลบไม่สำเร็จ'", () => {
    expect(statusView(withJob("error", J("uninstall", "archive", "failed")))).toEqual({ icon: "🔴", label: "ลบไม่สำเร็จ" })
  })
  it("an old failed job does not hide a healthy installed MID", () => {
    expect(statusView(withJob("installed", J("install", "extract", "failed"), "running"))).toEqual({ icon: "🟢", label: "กำลังรัน" })
  })
  it("succeeded/cancelled jobs and a null job fall back to the service state", () => {
    expect(statusView(withJob("installed", J("install", "markRemoved", "succeeded"), "running"))).toEqual({ icon: "🟢", label: "กำลังรัน" })
    expect(statusView(withJob("installed", J("install", "extract", "cancelled"), "stopped"))).toEqual({ icon: "⚪", label: "หยุด" })
    expect(statusView({ ...mid("installed", "stopped"), job: null })).toEqual({ icon: "⚪", label: "หยุด" })
  })
})

describe("jobIsActive / failedJobShown", () => {
  it("detects an active job", () => {
    expect(jobIsActive(withJob("installing", J("install", "extract", "running")))).toBe(true)
    expect(jobIsActive(withJob("installed", J("install", "extract", "failed")))).toBe(false)
    expect(jobIsActive(mid("installed", "running"))).toBe(false)
  })
  it("shows a failed job only while the MID is not healthy", () => {
    expect(failedJobShown(withJob("error", J("install", "extract", "failed")))).toBe(true)
    expect(failedJobShown(withJob("installed", J("install", "extract", "failed")))).toBe(false)
    expect(failedJobShown(withJob("error", J("install", "extract", "succeeded")))).toBe(false)
  })
})

describe("resumableUninstall", () => {
  it("true for queued/running/failed uninstall jobs only", () => {
    for (const s of ["queued", "running", "failed"]) expect(resumableUninstall(withJob("uninstalling", J("uninstall", "stop", s)))).toBe(true)
    expect(resumableUninstall(withJob("installed", J("uninstall", "stop", "failed")))).toBe(false) // revived/re-imported since
    expect(resumableUninstall(withJob("error", J("uninstall", "stop", "failed")))).toBe(false)
    expect(resumableUninstall(withJob("uninstalling", J("uninstall", "stop", "succeeded")))).toBe(false)
    expect(resumableUninstall(withJob("uninstalling", J("uninstall", "stop", "cancelled")))).toBe(false)
    expect(resumableUninstall(withJob("installing", J("install", "extract", "running")))).toBe(false)
    expect(resumableUninstall(mid("installed", "running"))).toBe(false)
  })
})

describe("quotaView", () => {
  it("full at 4/4", () => expect(quotaView(4, 4)).toEqual({ text: "กำลังรัน 4/4", full: true }))
  it("not full at 2/4", () => expect(quotaView(2, 4)).toEqual({ text: "กำลังรัน 2/4", full: false }))
})

describe("formatJobTime", () => {
  it("renders Asia/Bangkok time and tolerates bad input", () => {
    expect(formatJobTime("2026-11-18T17:30:00Z")).toMatch(/00:30/) // UTC+7 crosses midnight
    expect(formatJobTime(undefined)).toBe("-")
    expect(formatJobTime("nope")).toBe("-")
  })
})

describe("formatters", () => {
  it("bytes", () => {
    expect(formatBytes(null)).toBe("-")
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB")
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB")
  })
  it("uptime", () => {
    const now = Date.parse("2026-11-18T12:00:00Z")
    expect(formatUptime(null, now)).toBe("-")
    expect(formatUptime("2026-11-18T11:59:30Z", now)).toBe("น้อยกว่า 1 นาที")
    expect(formatUptime("2026-11-18T10:30:00Z", now)).toBe("1 ชม. 30 นาที")
    expect(formatUptime("2026-11-15T09:00:00Z", now)).toBe("3 วัน 3 ชม.")
  })
})
