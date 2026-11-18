/** JSON shape of GET /api/mids as the browser sees it (Date -> ISO string). */
import { isActiveJobStatus, isRemovalKind, runningJobLabel } from "./stages"

export type MidJobView = { id: string; kind: string; stage: string; status: string; createdAt?: string }

export type MidView = {
  name: string
  instanceUrl: string | null
  midName: string | null
  heapMb: number
  version: string | null
  state: string
  /** Latest job of this MID (GET /api/mids). */
  job?: MidJobView | null
  status: {
    state: "running" | "stopped" | "failed" | "starting" | "unknown"
    pid: number | null
    memoryBytes: number | null
    since: string | null
  }
}

export type HostView = {
  totalBytes: number
  availableBytes: number
  running: number
  quotaUsed: number
  maxRunning: number
  disk?: { freeBytes: number | null; totalBytes: number | null; usage: { mids: number; packages: number; archive: number } | null }
}

export type StatusView = { icon: "🟢" | "⚪" | "🟡" | "🔴"; label: string }

const BUSY: StatusView = { icon: "🟡", label: "กำลังทำงาน" }

type JobPick = Pick<MidView, "state" | "status" | "job">

export function jobIsActive(m: Pick<MidView, "job">): boolean {
  return !!m.job && isActiveJobStatus(m.job.status)
}

/** A failed job still matters while the MID is not in a healthy installed state (a stale failure must not hide it). */
export function failedJobShown(m: Pick<MidView, "state" | "job">): boolean {
  return m.job?.status === "failed" && (m.state === "installing" || m.state === "error" || m.state === "uninstalling")
}

/** An uninstall job that is still running or failed: the dashboard resumes its dialog (progress, retry, record link). */
export function resumableUninstall(m: Pick<MidView, "job" | "state">): boolean {
  // A failed uninstall only counts while the MID is still "uninstalling" (not re-imported or revived since).
  return m.job?.kind === "uninstall" && (isActiveJobStatus(m.job.status) || (m.job.status === "failed" && m.state === "uninstalling"))
}

export function statusView(m: JobPick): StatusView {
  if (m.job && jobIsActive(m)) return { icon: "🟡", label: runningJobLabel(m.job) }
  if (m.job && failedJobShown(m)) return { icon: "🔴", label: isRemovalKind(m.job.kind) ? "ลบไม่สำเร็จ" : "ติดตั้งไม่สำเร็จ" }
  if (m.state === "installing" || m.state === "upgrading" || m.state === "uninstalling") return BUSY
  if (m.state === "error") return { icon: "🔴", label: "ล่ม" }
  switch (m.status.state) {
    case "running": return { icon: "🟢", label: "กำลังรัน" }
    case "stopped": return { icon: "⚪", label: "หยุด" }
    case "starting": return BUSY
    case "failed": return { icon: "🔴", label: "ล่ม" }
    default: return { icon: "⚪", label: "ไม่ทราบสถานะ" }
  }
}

/** `used` is the helper's quotaUsed (slots held), not just processes that are currently running. */
export function quotaView(used: number, max: number): { text: string; full: boolean } {
  return { text: `กำลังรัน ${used}/${max}`, full: used >= max }
}

export function formatBytes(b: number | null): string {
  if (b === null) return "-"
  const gb = b / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(b / 1024 ** 2)} MB`
}

export function formatUptime(since: string | null, now: number = Date.now()): string {
  if (!since) return "-"
  const t = Date.parse(since)
  if (Number.isNaN(t)) return "-"
  const mins = Math.floor((now - t) / 60000)
  if (mins < 1) return "น้อยกว่า 1 นาที"
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  if (days > 0) return `${days} วัน ${hours} ชม.`
  if (hours > 0) return `${hours} ชม. ${mins % 60} นาที`
  return `${mins} นาที`
}

/** "18 พ.ย. 2569 12:00" style timestamp in Bangkok time (the host and users run on Asia/Bangkok). */
export function formatJobTime(iso: string | undefined): string {
  if (!iso) return "-"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "-"
  return new Date(t).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })
}
