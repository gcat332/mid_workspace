// Pure formatting for the audit page (unit tested; no React).

const ACTION_LABELS: Record<string, string> = {
  "mid.import": "นำเข้า MID",
  "mid.start": "เริ่ม MID",
  "mid.stop": "หยุด MID",
  "mid.restart": "รีสตาร์ท MID",
  "mid.fix_ownership": "ซ่อมสิทธิ์ไฟล์ MID",
  "mid.reconcile": "ระบบแก้สถานะ MID ที่ค้าง",
  "job.create": "สร้างงานติดตั้ง MID",
  "job.retry": "ลองงานใหม่",
  "job.cancel": "ยกเลิกงาน",
  "mid.agent_access": "อนุญาต/ยกเลิก AgentHub แก้ไฟล์",
  "mid.uninstall": "ถอนการติดตั้ง MID",
  "config.save": "บันทึกคอนฟิก",
  "config.rollback": "ย้อนคอนฟิก",
  "file.write": "แก้ไขไฟล์",
  "file.upload": "อัปโหลดไฟล์",
  "file.rename": "เปลี่ยนชื่อไฟล์",
  "file.delete": "ลบไฟล์",
  "file.mkdir": "สร้างโฟลเดอร์",
  "user.create": "เพิ่มผู้ใช้",
  "user.update": "แก้ไขผู้ใช้",
  "user.delete": "ลบผู้ใช้",
  "idp.update": "แก้ตั้งค่า SSO",
  "instance.create": "เพิ่ม Instance",
  "instance.update": "แก้ไข Instance",
  "instance.delete": "ลบ Instance",
  "instance.test": "ทดสอบการเชื่อมต่อ Instance",
  "ip_allowlist.add": "เพิ่ม IP Allowlist",
  "ip_allowlist.remove": "ลบ IP Allowlist",
}

/** Thai label of an audit action, or null when unknown (the page then shows the raw action name). */
export const actionLabel = (action: string): string | null => ACTION_LABELS[action] ?? null

const KEY_LABELS: Record<string, string> = {
  path: "พาธ",
  file: "ไฟล์",
  to: "เปลี่ยนเป็น",
  size: "ขนาด",
  backupId: "backup",
  note: "หมายเหตุ",
  targetEmail: "ผู้ใช้",
  role: "สิทธิ์",
  ssoOnly: "SSO เท่านั้น",
  unlock: "ปลดล็อก",
  passwordChanged: "เปลี่ยนรหัสผ่าน",
  cidr: "IP/CIDR",
  enabled: "เปิดใช้",
  provider: "Provider",
  issuer: "Issuer",
  clientId: "Client ID",
  secretChanged: "เปลี่ยน Client Secret",
  instanceUrl: "Instance",
  url: "URL",
  label: "ชื่อ",
  revived: "นำเข้าซ้ำ",
  confirmLowMemory: "ยืนยันทั้งที่ RAM น้อย",
  fixOwnership: "ซ่อมสิทธิ์ไฟล์",
  ok: "ผลลัพธ์",
  code: "รหัสข้อผิดพลาด",
  kind: "ประเภทงาน",
  snName: "ชื่อใน ServiceNow",
  cloneFrom: "โคลนจาก",
  jobId: "งาน",
  cancelledJobId: "งานที่ยกเลิก",
  cancelledKind: "ประเภทงานที่ยกเลิก",
  cleanupJobId: "งานล้างข้อมูล",
}

const ROLE_TH: Record<string, string> = { admin: "ผู้ดูแลระบบ", member: "สมาชิก" }

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function valueText(key: string, v: unknown): string {
  if (key === "ok" && typeof v === "boolean") return v ? "สำเร็จ" : "ไม่สำเร็จ"
  if (typeof v === "boolean") return v ? "ใช่" : "ไม่"
  if (key === "size" && typeof v === "number") return bytes(v)
  if (key === "role" && typeof v === "string") return ROLE_TH[v] ?? v
  if (v === null || v === undefined || v === "") return "-"
  return typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)
}

/** Readable `[label, value]` pairs of an audit detail; null when the detail is not a JSON object. */
export function detailPairs(detail: string): [string, string][] | null {
  let j: unknown
  try { j = JSON.parse(detail) } catch { return null }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null
  return Object.entries(j).map(([k, v]) => [KEY_LABELS[k] ?? k, valueText(k, v)])
}

/** Compact one-line JSON; falls back to the raw text when detail is not valid JSON. */
export function compactDetail(detail: string): string {
  try { return JSON.stringify(JSON.parse(detail)) } catch { return detail }
}
