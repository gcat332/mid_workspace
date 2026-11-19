// "May this MID be changed now": AgentHub's `mid_ready` check (lib/agent/checks.ts) and the browser write routes
// (actions, config, files) both use lifecycleBusy, with different allowed states: the agent check stays strict
// (`installed` only, spec 5.2); the browser also allows `error` so a failed install stays stoppable and fixable.
import { prisma } from "@/lib/db/client"
import { ACTIVE_JOB_STATUSES, jobStageLabelTh } from "@/lib/ui/stages"
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

/** States AgentHub may work on (spec 5.2): the default of lifecycleBusy. */
export const AGENT_READY_STATES: readonly string[] = ["installed"]
/** States the browser may write to: a failed install (`error`) must stay stoppable and its config fixable. */
export const BROWSER_WRITABLE_STATES: readonly string[] = ["installed", "error"]

/** Pure: null when the MID's state is in `allowed` and it has no active job, else the Thai reason. */
export function lifecycleBusy(m: LifecycleFacts, allowed: readonly string[] = AGENT_READY_STATES): string | null {
  if (m.activeJob) return `MID นี้กำลังมีงานอยู่ (${jobStageLabelTh(m.activeJob)}) รอให้เสร็จก่อน`
  if (m.state === "removed") return "MID นี้ถูกลบออกจาก MidHub แล้ว เลือก MID อื่น"
  if (!allowed.includes(m.state)) return `MID นี้ยังไม่พร้อมใช้งาน (${STATE_LABELS[m.state] ?? m.state}) รอให้เสร็จหรือให้ Admin ตรวจสอบก่อน`
  return null
}

/**
 * For browser write routes: 404 for an unknown MID, 409 `job_active` (with lifecycleBusy's reason) unless it is
 * `installed` or `error` with no queued/running lifecycle job (install/clone/uninstall/cancel_install). Reads skip this.
 */
export async function assertSettled(name: string): Promise<void> {
  validateMidName(name)
  const [row, job] = await Promise.all([
    prisma.midServer.findUnique({ where: { name }, select: { state: true } }),
    prisma.job.findFirst({ where: { midName: name, status: { in: ACTIVE_JOB_STATUSES } }, select: { stage: true } }),
  ])
  if (!row) throw new MidError("not_found")
  const reason = lifecycleBusy({ state: row.state, activeJob: job?.stage ?? null }, BROWSER_WRITABLE_STATES)
  if (reason) throw new MidError("job_active", 409, reason)
}
