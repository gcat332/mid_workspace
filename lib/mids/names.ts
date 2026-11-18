// Free of Next/Prisma imports: the root helper daemon imports this via lib/helper/protocol.ts.
import path from "node:path"

export const DEFAULT_MIDHUB_ROOT = "/opt/midhub"

import { MID_NAME_RE } from "./name-regex"
export { MID_NAME_RE }

const ERRORS = {
  invalid_name: [400, "ชื่อ MID ไม่ถูกต้อง ใช้ได้เฉพาะ a-z, 0-9 และ - (2-40 ตัวอักษร ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)"],
  path_outside: [400, "พาธอยู่นอกโฟลเดอร์ของ MID นี้ กรุณาระบุพาธภายใน MID เท่านั้น"],
  not_found: [404, "ไม่พบ MID หรือไฟล์ที่ระบุ ตรวจสอบชื่อ/พาธแล้วลองใหม่"],
  read_only: [403, "โฟลเดอร์นี้เป็นแบบอ่านอย่างเดียว (agent/bin, agent/lib, agent/jre) ไม่สามารถแก้ไขได้"],
  stale: [409, "ไฟล์ถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่แล้วแก้ไขอีกครั้ง"],
  quota_full: [409, "รันครบจำนวนสูงสุดแล้ว ให้หยุดตัวอื่นก่อน"],
  disk_full: [409, "พื้นที่ของ MID เต็ม ลบไฟล์ที่ไม่ใช้แล้วลองใหม่"],
  busy: [503, "ตัวช่วยระบบกำลังยุ่ง กรุณารอสักครู่แล้วลองใหม่"],
  invalid_request: [400, "คำขอไม่ถูกต้อง กรุณารีเฟรชหน้าแล้วลองใหม่ หากยังเป็นอีกให้แจ้ง Admin"],
  systemctl_failed: [500, "สั่ง systemd ไม่สำเร็จ ดูรายละเอียดด้านล่าง หรือแจ้ง Admin"],
  internal: [500, "ตัวช่วยระบบทำงานผิดพลาด ดูรายละเอียดด้านล่าง หรือแจ้ง Admin"],
  helper_down: [503, "บริการ helper (bsm-midhub-helper) ไม่ตอบสนอง ลองใหม่อีกครั้งในอีกสักครู่ หากยังไม่ได้ ผู้ดูแลเซิร์ฟเวอร์ต้องตรวจสอบ service นี้ (ดูรายละเอียด)"],
  not_a_mid: [400, "โฟลเดอร์นี้ไม่ใช่ MID Server ที่ถูกต้อง ตรวจสอบว่ามีโฟลเดอร์ agent อยู่"],
  not_text: [415, "ไฟล์นี้ไม่ใช่ไฟล์ข้อความ จึงเปิดแก้ไขในหน้าเว็บไม่ได้ ให้ดาวน์โหลดแทน"],
  too_large: [413, "ไฟล์ใหญ่เกินกำหนด (สูงสุด 50 MB) ลดขนาดไฟล์แล้วลองใหม่"],
  low_memory: [409, "หน่วยความจำของเซิร์ฟเวอร์ไม่พอ หยุด MID ที่ไม่ใช้งานก่อนแล้วลองใหม่"],
  use_config_tab: [403, "แก้ไฟล์นี้ในแท็บตั้งค่า (มี backup และ rollback)"],
  no_permission: [403, "ไม่มีสิทธิ์เข้าถึงไฟล์นี้ (สิทธิ์ไฟล์ไม่ถูกต้อง) กดปุ่ม \"ซ่อมสิทธิ์ไฟล์\" ด้านบนของ MID แล้วลองใหม่"],
  invalid_filename: [400, "ชื่อไฟล์/โฟลเดอร์ไม่ถูกต้อง: ห้ามว่าง ห้ามเป็น . หรือ .. ห้ามมี / หรือ \\ และยาวไม่เกิน 255 ไบต์ แก้ชื่อแล้วลองใหม่"],
  length_required: [411, "อัปโหลดต้องระบุขนาดไฟล์ (Content-Length) ลองอัปโหลดใหม่จากหน้านี้"],
  invalid_buildstamp: [400, "buildstamp ไม่ถูกต้อง ตรวจรูปแบบเช่น australia-02-11-2026__patch7…"],
  instance_url: [400, "URL ต้องเป็น https://<ชื่อ>.service-now.com เท่านั้น"],
  instance_auth: [400, "login ไม่ผ่าน: ตรวจ MID user/password"],
  instance_role: [400, "login ได้แต่ user ไม่มีสิทธิ์: ตรวจว่า user มี role mid_server"],
  instance_unreachable: [502, "ติดต่อ instance ไม่ได้: ตรวจ URL หรือว่า instance ตื่นอยู่ (demo instance อาจ hibernate)"],
  job_active: [409, "MID นี้มีงานที่กำลังทำอยู่ รอให้เสร็จหรือยกเลิกก่อน"],
  job_running: [409, "งานกำลังทำงานอยู่ ยกเลิกไม่ได้ในตอนนี้"],
  job_not_found: [404, "ไม่พบงานที่ระบุ รีเฟรชหน้าแล้วลองใหม่"],
  forbidden: [403, "ไม่มีสิทธิ์ทำรายการนี้ ติดต่อ Admin"],
  conflict: [409, "การดำเนินการนี้ขัดแย้งกับสถานะปัจจุบัน รีเฟรชหน้าแล้วลองใหม่"],
} as const satisfies Record<string, readonly [number, string]>

export type MidErrorCode = keyof typeof ERRORS

export { quotaFullMessage } from "./messages"

export class MidError extends Error {
  readonly code: string
  readonly status: number
  readonly detail?: string
  constructor(code: string, status?: number, thai?: string, detail?: string) {
    const known = (ERRORS as Record<string, readonly [number, string]>)[code]
    super(thai ?? known?.[1] ?? code)
    this.name = "MidError"
    this.code = code
    this.status = status ?? known?.[0] ?? 500
    this.detail = detail
  }
}

export function validateMidName(n: string): string {
  if (typeof n !== "string" || !MID_NAME_RE.test(n)) throw new MidError("invalid_name")
  return n
}

export const unitName = (n: string): string => `midhub-mid-${validateMidName(n)}.service`

// Reads process.env directly (not lib/env) so the root helper needn't have the app secrets; it passes `root` explicitly.
export const midRoot = (n: string, root: string = process.env.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT): string =>
  path.join(root, "mids", validateMidName(n))
