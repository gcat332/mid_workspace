/** Thai labels for job stages and kinds, shared by the progress view and the status view. */
export const STAGE_LABELS: Record<string, string> = {
  precheck: "ตรวจความพร้อม",
  fetchPackage: "ดาวน์โหลดแพ็กเกจ MID",
  extract: "แตกไฟล์",
  copyFiles: "คัดลอกไฟล์จาก MID ต้นทาง",
  configure: "ตั้งค่า MID",
  fixOwnership: "ตั้งสิทธิ์ไฟล์",
  installUnit: "ติดตั้งบริการ (systemd)",
  start: "เริ่มทำงาน",
  waitConnected: "รอเชื่อมต่อกับ ServiceNow",
  stop: "หยุด MID",
  removeUnit: "ถอนบริการ (systemd)",
  archive: "สำรองไฟล์",
  deleteDir: "ลบโฟลเดอร์",
  markRemoved: "ปิดรายการ",
}

export const jobStageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage

export const KIND_LABELS: Record<string, string> = {
  install: "ติดตั้ง",
  clone: "ติดตั้ง (โคลน)",
  uninstall: "ลบ",
  cancel_install: "ยกเลิกการติดตั้ง",
}
export const jobKindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind

export const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "รอคิว",
  pending: "รอคิว",
  running: "กำลังทำงาน",
  succeeded: "สำเร็จ",
  failed: "ล้มเหลว",
  cancelled: "ยกเลิกแล้ว",
}
export const jobStatusLabel = (status: string): string => JOB_STATUS_LABELS[status] ?? status

const ACTIVE = new Set(["queued", "pending", "running"])
export const isActiveJobStatus = (status: string): boolean => ACTIVE.has(status)

const REMOVAL_KINDS = new Set(["uninstall", "cancel_install"])
export const isRemovalKind = (kind: string): boolean => REMOVAL_KINDS.has(kind)

/** In-progress wording for a running job (status badge): the install stages that take long, and removal. */
const RUNNING_LABELS: Record<string, string> = {
  fetchPackage: "กำลังดาวน์โหลด",
  extract: "กำลังแตกไฟล์",
  configure: "กำลังตั้งค่า",
  waitConnected: "รอเชื่อมต่อ instance",
}
export function runningJobLabel(job: { kind: string; stage: string }): string {
  if (isRemovalKind(job.kind)) return "กำลังลบ"
  return RUNNING_LABELS[job.stage] ?? "กำลังติดตั้ง"
}
