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
