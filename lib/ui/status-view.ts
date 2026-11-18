/** JSON shape of GET /api/mids as the browser sees it (Date -> ISO string). */
export type MidView = {
  name: string
  instanceUrl: string | null
  midName: string | null
  heapMb: number
  version: string | null
  state: string
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
}

export type StatusView = { icon: "🟢" | "⚪" | "🟡" | "🔴"; label: string }

const BUSY: StatusView = { icon: "🟡", label: "กำลังทำงาน" }

export function statusView(m: Pick<MidView, "state" | "status">): StatusView {
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
