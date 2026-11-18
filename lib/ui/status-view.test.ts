import { describe, expect, it } from "vitest"
import { formatBytes, formatUptime, quotaView, statusView, type MidView } from "./status-view"

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

describe("quotaView", () => {
  it("full at 4/4", () => expect(quotaView(4, 4)).toEqual({ text: "กำลังรัน 4/4", full: true }))
  it("not full at 2/4", () => expect(quotaView(2, 4)).toEqual({ text: "กำลังรัน 2/4", full: false }))
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
