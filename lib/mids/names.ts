// Free of Next/Prisma imports: the root helper daemon imports this via lib/helper/protocol.ts.
import path from "node:path"
import { env } from "@/lib/env"

export const MID_NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

const ERRORS = {
  invalid_name: [400, "ชื่อ MID ไม่ถูกต้อง ใช้ได้เฉพาะ a-z, 0-9 และ - (2-40 ตัวอักษร ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)"],
  path_outside: [400, "พาธอยู่นอกโฟลเดอร์ของ MID นี้ กรุณาระบุพาธภายใน MID เท่านั้น"],
  not_found: [404, "ไม่พบ MID หรือไฟล์ที่ระบุ ตรวจสอบชื่อ/พาธแล้วลองใหม่"],
  read_only: [403, "โฟลเดอร์นี้เป็นแบบอ่านอย่างเดียว (agent/bin, agent/lib, agent/jre) ไม่สามารถแก้ไขได้"],
  stale: [409, "ไฟล์ถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่แล้วแก้ไขอีกครั้ง"],
  quota_full: [409, "พื้นที่ของ MID เต็ม ลบไฟล์ที่ไม่ใช้แล้วลองใหม่"],
  helper_down: [503, "บริการ helper ไม่ตอบสนอง ตรวจสอบว่า midhub-helper ทำงานอยู่ แล้วลองใหม่"],
  not_a_mid: [400, "โฟลเดอร์นี้ไม่ใช่ MID Server ที่ถูกต้อง ตรวจสอบว่ามีโฟลเดอร์ agent อยู่"],
  not_text: [415, "ไฟล์นี้ไม่ใช่ไฟล์ข้อความ จึงเปิดแก้ไขในหน้าเว็บไม่ได้ ให้ดาวน์โหลดแทน"],
  too_large: [413, "ไฟล์ใหญ่เกินกำหนด (สูงสุด 50 MB) ลดขนาดไฟล์แล้วลองใหม่"],
  low_memory: [409, "หน่วยความจำของเซิร์ฟเวอร์ไม่พอ หยุด MID ที่ไม่ใช้งานก่อนแล้วลองใหม่"],
  conflict: [409, "การดำเนินการนี้ขัดแย้งกับสถานะปัจจุบัน รีเฟรชหน้าแล้วลองใหม่"],
} as const satisfies Record<string, readonly [number, string]>

export type MidErrorCode = keyof typeof ERRORS

export class MidError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status?: number, thai?: string) {
    const known = (ERRORS as Record<string, readonly [number, string]>)[code]
    super(thai ?? known?.[1] ?? code)
    this.name = "MidError"
    this.code = code
    this.status = status ?? known?.[0] ?? 500
  }
}

export function validateMidName(n: string): string {
  if (typeof n !== "string" || !MID_NAME_RE.test(n)) throw new MidError("invalid_name")
  return n
}

export const unitName = (n: string): string => `midhub-mid-${validateMidName(n)}.service`

export const midRoot = (n: string): string => path.join(env.midhubRoot, "mids", validateMidName(n))
