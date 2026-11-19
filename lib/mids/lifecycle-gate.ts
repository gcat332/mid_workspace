// One rule for "may this MID be changed now": AgentHub's `mid_ready` check (lib/agent/checks.ts) and the browser
// write routes (actions, config, files) both use lifecycleBusy, so the server refuses what the UI's busyReason hides.
import { prisma } from "@/lib/db/client"
import { ACTIVE_JOB_STATUSES, jobStageLabel } from "@/lib/ui/stages"
import { MidError, validateMidName } from "./names"

export type LifecycleFacts = {
  state: string
  /** stage of the MID's active (queued/running) job, or null */
  activeJob: string | null
}

const STATE_LABELS: Record<string, string> = {
  installing: "กำลังติดตั้ง",
  uninstalling: "กำลังลบ",
  upgrading: "กำลังอัปเกรด",
  error: "ผิดพลาด",
}

/** Pure: null when the MID is `installed` with no active job, else the Thai reason. */
export function lifecycleBusy(m: LifecycleFacts): string | null {
  if (m.activeJob) return `MID นี้กำลังมีงานอยู่ (${jobStageLabel(m.activeJob)}) รอให้เสร็จก่อน`
  if (m.state === "removed") return "MID นี้ถูกลบออกจาก MidHub แล้ว เลือก MID อื่น"
  if (m.state !== "installed") return `MID นี้ยังไม่พร้อมใช้งาน (${STATE_LABELS[m.state] ?? m.state}) รอให้เสร็จหรือให้ Admin ตรวจสอบก่อน`
  return null
}

/**
 * For browser write routes: 404 for an unknown/removed MID, 409 `job_active` (with lifecycleBusy's reason) while it is
 * not `installed` or a lifecycle job (install/clone/uninstall/cancel_install) is queued or running. Reads skip this.
 */
export async function assertSettled(name: string): Promise<void> {
  validateMidName(name)
  const [row, job] = await Promise.all([
    prisma.midServer.findUnique({ where: { name }, select: { state: true } }),
    prisma.job.findFirst({ where: { midName: name, status: { in: ACTIVE_JOB_STATUSES } }, select: { stage: true } }),
  ])
  if (!row || row.state === "removed") throw new MidError("not_found")
  const reason = lifecycleBusy({ state: row.state, activeJob: job?.stage ?? null })
  if (reason) throw new MidError("job_active", 409, reason)
}
