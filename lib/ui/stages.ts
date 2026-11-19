/** English Title Case labels for job stages and kinds, shared by the progress view and the status view. */
export const STAGE_LABELS: Record<string, string> = {
  precheck: "Precheck",
  fetchPackage: "Download Package",
  extract: "Extract Files",
  copyFiles: "Copy Files",
  configure: "Configure MID",
  fixOwnership: "Set File Permissions",
  installUnit: "Install Service",
  start: "Start MID",
  waitConnected: "Wait for ServiceNow",
  stop: "Stop MID",
  removeUnit: "Remove Service",
  archive: "Archive Files",
  deleteDir: "Delete Folder",
  markRemoved: "Mark Removed",
}

/** Thai wording of the stages, for server messages and the AgentHub API (the UI itself is English). */
export const STAGE_LABELS_TH: Record<string, string> = {
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
export const jobStageLabelTh = (stage: string): string => STAGE_LABELS_TH[stage] ?? stage

export const jobStageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage

export const KIND_LABELS: Record<string, string> = {
  install: "Install",
  clone: "Install (Clone)",
  uninstall: "Uninstall",
  cancel_install: "Cancel Install",
}
export const jobKindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind

export const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  pending: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}
export const jobStatusLabel = (status: string): string => JOB_STATUS_LABELS[status] ?? status

export const ACTIVE_JOB_STATUSES = ["queued", "pending", "running"]
const ACTIVE = new Set(ACTIVE_JOB_STATUSES)
export const isActiveJobStatus = (status: string): boolean => ACTIVE.has(status)

const REMOVAL_KINDS = new Set(["uninstall", "cancel_install"])
export const isRemovalKind = (kind: string): boolean => REMOVAL_KINDS.has(kind)

/** In-progress wording for a running job (status badge): the install stages that take long, and removal. */
const RUNNING_LABELS: Record<string, string> = {
  fetchPackage: "Downloading",
  extract: "Extracting",
  configure: "Configuring",
  waitConnected: "Waiting for Instance",
}
const RUNNING_LABELS_TH: Record<string, string> = {
  fetchPackage: "กำลังดาวน์โหลด",
  extract: "กำลังแตกไฟล์",
  configure: "กำลังตั้งค่า",
  waitConnected: "รอเชื่อมต่อ instance",
}
export function runningJobLabel(job: { kind: string; stage: string }, locale: "en" | "th" = "en"): string {
  const th = locale === "th"
  if (isRemovalKind(job.kind)) return th ? "กำลังลบ" : "Removing"
  return (th ? RUNNING_LABELS_TH : RUNNING_LABELS)[job.stage] ?? (th ? "กำลังติดตั้ง" : "Installing")
}
