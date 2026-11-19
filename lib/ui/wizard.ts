// Pure step validation and helpers for the Create-MID wizard (no React, no server imports).
import { MAX_HEAP_MB, MIN_HEAP_MB } from "@/lib/helper/protocol"
import { MIN_FREE_BYTES } from "@/lib/mids/layout"
import { MID_NAME_RE } from "@/lib/mids/name-regex"
import type { HostView } from "./status-view"

// Duplicate of BUILDSTAMP_RE in lib/mids/buildstamp.ts: that module imports lib/mids/names.ts (node:path), which must
// not enter the browser bundle. wizard.test.ts asserts both regexes accept/reject the same samples.
export const BUILDSTAMP_RE =
  /^[a-z]+-\d{2}-\d{2}-\d{4}(?:__patch[0-9a-z]+(?:-hotfix[0-9a-z]+)?-\d{2}-\d{2}-\d{4})?_\d{2}-\d{2}-\d{4}_\d{4}$/
// Same as SN_NAME_RE in lib/jobs/lifecycle.ts (server-only module).
export const SN_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/

export const DEFAULT_HEAP_MB = 1024
export const DEFAULT_LOG_FILES = 3
const GIB = 1024 ** 3

export type NameCheck = "idle" | "checking" | "available" | "taken" | "invalid" | "error"

export type NameResult = { name: string; status: "available" | "taken" | "error"; message?: string }

/** Name-check state from the typed name and the latest server answer (an answer for an older name does not count). */
export function deriveNameCheck(name: string, r: NameResult | null): NameCheck {
  if (!name) return "idle"
  if (!MID_NAME_RE.test(name)) return "invalid"
  return r && r.name === name ? r.status : "checking"
}

export type WizardState = {
  instance: { id: string; hasPassword: boolean; buildstamp: string | null } | null
  /** a "new instance" form is open but not yet tested and saved */
  pendingNew: boolean
  /** buildstamp chosen/typed when the instance has none */
  buildstamp: string
  name: string
  nameCheck: NameCheck
  snName: string
  heapMb: string
  logFiles: string
  proxyOn: boolean
  proxyHost: string
  proxyPort: string
}

export type Check = { level: "ok" | "warn" | "block"; text: string }
export type Verdict = { ok: boolean; reason?: string }

export function effectiveBuildstamp(s: Pick<WizardState, "instance" | "buildstamp">): string {
  return (s.instance?.buildstamp ?? s.buildstamp).trim()
}

const intIn = (v: string, min: number, max: number): boolean => /^\d+$/.test(v.trim()) && +v >= min && +v <= max
const no = (reason: string): Verdict => ({ ok: false, reason })

export function canProceed(step: 1 | 2 | 3, s: WizardState, checks: Check[] = []): Verdict {
  if (step === 1) {
    if (s.pendingNew) return no("กด “Test and Save” ให้ผ่านก่อน จึงจะไปต่อได้")
    if (!s.instance) return no("เลือก instance หรือเพิ่ม instance ใหม่ก่อน")
    if (!s.instance.hasPassword) return no("instance นี้ยังไม่มีรหัส MID user ให้ Admin ใส่รหัสก่อน")
    const b = effectiveBuildstamp(s)
    if (!b) return no("instance นี้ยังไม่ทราบ build เลือกแพ็กเกจที่มี หรือพิมพ์ buildstamp")
    if (!BUILDSTAMP_RE.test(b)) return no("รูปแบบ buildstamp ไม่ถูกต้อง เช่น washingtondc-12-08-2023__patch5-02-14-2024_02-23-2024_1115")
    return { ok: true }
  }
  if (step === 2) {
    if (!s.name) return no("ตั้งชื่อ MID ก่อน")
    if (!MID_NAME_RE.test(s.name)) return no("ชื่อ MID ใช้ได้เฉพาะ a-z, 0-9 และ - (2-40 ตัวอักษร ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)")
    if (s.nameCheck === "checking" || s.nameCheck === "idle") return no("กำลังตรวจสอบว่าชื่อว่างหรือไม่...")
    if (s.nameCheck === "error") return no("ตรวจชื่อไม่สำเร็จ (เชื่อมต่อเซิร์ฟเวอร์ไม่ได้) กด “Check Again” ข้างช่องชื่อ")
    if (s.nameCheck !== "available") return no("ชื่อนี้ใช้ไม่ได้ ใช้ชื่ออื่น")
    if (!SN_NAME_RE.test(s.snName)) return no("ชื่อ MID ใน ServiceNow ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-80 ตัวอักษร)")
    if (!intIn(s.heapMb, MIN_HEAP_MB, MAX_HEAP_MB)) return no(`heap ต้องเป็นจำนวนเต็ม ${MIN_HEAP_MB}-${MAX_HEAP_MB} MB`)
    if (!intIn(s.logFiles, 1, 10)) return no("จำนวนไฟล์ log ต้องเป็นจำนวนเต็ม 1-10")
    if (s.proxyOn) {
      if (!s.proxyHost.trim()) return no("ใส่ proxy host หรือปิดการใช้ proxy")
      if (!intIn(s.proxyPort, 1, 65535)) return no("proxy port ต้องเป็นเลข 1-65535")
    }
    return { ok: true }
  }
  const blocker = checks.find((c) => c.level === "block")
  return blocker ? no(blocker.text) : { ok: true }
}

/** Step 3 pre-flight checks from /api/host. Unknown values warn (never silently pass). */
export function reviewChecks(host: HostView | null): Check[] {
  const out: Check[] = []
  const free = host?.disk?.freeBytes ?? null
  if (free === null) out.push({ level: "warn", text: "อ่านพื้นที่ดิสก์ไม่ได้ ระบบจะตรวจอีกครั้งตอนติดตั้ง" })
  else if (free < MIN_FREE_BYTES) out.push({ level: "block", text: `พื้นที่ดิสก์ว่างเหลือ ${(free / GIB).toFixed(1)} GB (ต้องการอย่างน้อย 2 GB) ลบ MID หรือแพ็กเกจที่ไม่ใช้ก่อน` })
  else out.push({ level: "ok", text: `พื้นที่ดิสก์ว่าง ${(free / GIB).toFixed(1)} GB เพียงพอ` })

  if (!host) out.push({ level: "warn", text: "อ่านโควต้า MID ที่รันพร้อมกันไม่ได้" })
  else if (host.quotaUsed >= host.maxRunning) {
    out.push({ level: "warn", text: `โควต้าเต็ม (${host.quotaUsed}/${host.maxRunning}) จะติดตั้งได้ แต่ start ไม่ได้จนกว่าจะหยุดตัวอื่น` })
  } else out.push({ level: "ok", text: `โควต้ายังว่าง (ใช้ ${host.quotaUsed}/${host.maxRunning})` })

  if (!host) out.push({ level: "warn", text: "อ่านหน่วยความจำ (RAM) ของเครื่องไม่ได้" })
  else if (host.availableBytes < GIB) out.push({ level: "warn", text: `RAM ว่างเหลือ ${(host.availableBytes / GIB).toFixed(1)} GB (น้อยกว่า 1 GB) MID อาจ start ไม่ขึ้น` })
  else out.push({ level: "ok", text: `RAM ว่าง ${(host.availableBytes / GIB).toFixed(1)} GB` })
  return out
}

export { jobStageLabel } from "./stages"

/** Last "ดาวน์โหลด package NN%" journal message, or null. */
export function parseProgress(msgs: string[]): number | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = /^ดาวน์โหลด package (\d{1,3})%$/.exec(msgs[i])
    if (m) return Math.min(100, +m[1])
  }
  return null
}

export type JournalEntry = { type?: string; level?: string; msg?: string; stage?: string; message?: string; detail?: string; code?: string; t?: string }
