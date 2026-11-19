import { expect, it } from "vitest"
import { actionLabel, detailPairs } from "./audit-format"

it("labels admin and MID actions in Thai, unknown actions fall back to the raw name", () => {
  expect(actionLabel("user.create")).toBe("เพิ่มผู้ใช้")
  expect(actionLabel("ip_allowlist.remove")).toBe("ลบ IP Allowlist")
  expect(actionLabel("idp.update")).toBe("แก้ตั้งค่า SSO")
  expect(actionLabel("mid.fix_ownership")).toBe("ซ่อมสิทธิ์ไฟล์ MID")
  expect(actionLabel("x.y")).toBeNull()
})

it("renders detail as readable Thai key: value pairs (Q-I3)", () => {
  expect(detailPairs(JSON.stringify({ path: "agent/extlib/a.jar", size: 2048 }))).toEqual([["พาธ", "agent/extlib/a.jar"], ["ขนาด", "2.0 KB"]])
  expect(detailPairs(JSON.stringify({ targetEmail: "m@x.com", role: "admin", passwordChanged: true }))).toEqual([
    ["ผู้ใช้", "m@x.com"], ["สิทธิ์", "ผู้ดูแลระบบ"], ["เปลี่ยนรหัสผ่าน", "ใช่"],
  ])
  expect(detailPairs(JSON.stringify({ ok: false, code: "quota_full" }))).toEqual([["ผลลัพธ์", "ไม่สำเร็จ"], ["รหัสข้อผิดพลาด", "quota_full"]])
  expect(detailPairs(JSON.stringify({ weird: { a: 1 } }))).toEqual([["weird", '{"a":1}']])
})

it("empty or non-JSON detail", () => {
  expect(detailPairs("{}")).toEqual([])
  expect(detailPairs("not json")).toBeNull()
})

it("labels AgentHub actions in Thai (spec §7)", () => {
  for (const a of ["agent.file.write", "agent.file.upload", "agent.file.mkdir", "agent.file.rename", "agent.file.delete", "agent.restart", "agent.check_failed"]) {
    expect(actionLabel(a), a).toMatch(/AgentHub/)
  }
  expect(actionLabel("agent.file.upload")).toBe("AgentHub อัปโหลดไฟล์")
  expect(actionLabel("agent.check_failed")).toBe("AgentHub ถูกปฏิเสธ (เช็กไม่ผ่าน)")
})

it("shows via: agenthub and the taskId first in the detail pairs", () => {
  const d = JSON.stringify({ path: "agent/extlib/a.jar", via: "agenthub", taskId: "task-9", sessionInstances: ["https://a.service-now.com/", "https://b.service-now.com/"], size: 10 })
  expect(detailPairs(d)).toEqual([
    ["ผ่าน", "agenthub"],
    ["Task (AgentHub)", "task-9"],
    ["พาธ", "agent/extlib/a.jar"],
    ["Instance ของ session", "https://a.service-now.com/, https://b.service-now.com/"],
    ["ขนาด", "10 B"],
  ])
  expect(detailPairs(JSON.stringify({ via: "agenthub", taskId: "t", failed: ["agent_access", "mid_ready"] }))).toEqual([
    ["ผ่าน", "agenthub"], ["Task (AgentHub)", "t"], ["เช็กที่ไม่ผ่าน", "agent_access, mid_ready"],
  ])
})

it("labels sign-in via AgentHub, denials and lock/unlock (AgentHub SSO)", () => {
  expect(actionLabel("auth.login")).toBe("เข้าสู่ระบบ (ผ่าน AgentHub)")
  expect(actionLabel("auth.denied")).toBe("ถูกปฏิเสธการเข้าใช้ MidHub")
  expect(detailPairs(JSON.stringify({ via: "agenthub" }))).toEqual([["ผ่าน", "agenthub"]])
  expect(detailPairs(JSON.stringify({ reason: "not_admin" }))).toEqual([["เหตุผล", "ไม่ใช่ admin ของ AgentHub"]])
  expect(detailPairs(JSON.stringify({ targetEmail: "m@x.com", lock: true }))).toEqual([["ผู้ใช้", "m@x.com"], ["ล็อก", "ใช่"]])
})

it("labels user.created (agent call created a MidHub admin) and its email detail", () => {
  expect(actionLabel("user.created")).toBe("สร้างผู้ใช้ (admin จาก AgentHub)")
  expect(detailPairs(JSON.stringify({ via: "agenthub", email: "new@x.com" }))).toEqual([["ผ่าน", "agenthub"], ["อีเมล", "new@x.com"]])
})
