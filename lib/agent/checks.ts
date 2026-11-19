import { recordAudit } from "@/lib/audit"
import { normalizeInstanceUrl } from "@/lib/instances/url"
import { MidError, validateMidName } from "@/lib/mids/names"
import { getMid, type MidSummary } from "@/lib/mids/registry"
import { lifecycleBusy } from "@/lib/mids/lifecycle-gate"
import { isActiveJobStatus } from "@/lib/ui/stages"
import type { AgentCaller } from "@/lib/agent/auth"

export type CheckId = "user_registered" | "session_instance" | "instance_match" | "agent_access" | "mid_ready"
export type Check = { id: CheckId; ok: boolean; message?: string }

export type MidFacts = {
  agentAccess: boolean
  state: string
  activeJob: string | null
  instanceUrl: string | null
  configUrl: string | null
}

const canon = (u: string | null): string | null => {
  if (!u) return null
  try { return normalizeInstanceUrl(u) } catch { return null }
}
const host = (u: string): string => { try { return new URL(u).hostname } catch { return u } }

/** Pure: the five checks of spec 5.2 in fixed order. */
export function evaluateChecks(caller: AgentCaller, mid: MidFacts): Check[] {
  const fail = (id: CheckId, message: string): Check => ({ id, ok: false, message })
  const ok = (id: CheckId): Check => ({ id, ok: true })

  const session = caller.sessionInstances.map((u) => canon(u) ?? u)
  const inst = canon(mid.instanceUrl)
  const cfg = canon(mid.configUrl)

  const sessionHosts = session.map(host).join(", ")
  let match: Check
  if (session.length === 0) {
    match = ok("instance_match") // session_instance already reports the empty set
  } else if (!inst && !cfg) {
    match = fail("instance_match", `session นี้ทำงานกับ ${sessionHosts} แต่ระบุไม่ได้ว่า MID นี้ต่อ instance ไหน ตรวจ config.xml ของ MID แล้วลองใหม่`)
  } else if (inst && cfg && inst !== cfg) {
    match = fail("instance_match", `session นี้ทำงานกับ ${sessionHosts} แต่ MID นี้ต่อ ${host(inst)} และ config.xml ชี้ ${host(cfg)} ไม่ตรงกัน ให้ Admin ตรวจ instance ของ MID นี้`)
  } else {
    const c = (inst ?? cfg) as string
    match = session.includes(c)
      ? ok("instance_match")
      : fail("instance_match", `session นี้ทำงานกับ ${sessionHosts} แต่ MID นี้ต่อ ${host(c)} เลือก MID ที่ต่อ instance ของ session หรือเพิ่ม instance นั้นใน .env`)
  }

  // Same rule as the browser write routes (lib/mids/lifecycle-gate.ts).
  const busy = lifecycleBusy(mid)
  const ready = busy ? fail("mid_ready", busy) : ok("mid_ready")

  return [
    ok("user_registered"), // auth already rejected unregistered/locked actors
    caller.sessionInstances.length > 0
      ? ok("session_instance")
      : fail("session_instance", "session นี้ยังไม่มี instance: ตั้ง SN_INSTANCE_URL ใน .env หรือสร้างโปรเจกต์ด้วย snow-init"),
    match,
    mid.agentAccess ? ok("agent_access") : fail("agent_access", "MID นี้ยังไม่เปิดให้ AgentHub แก้ ให้เปิดในหน้า MidHub แท็บภาพรวม"),
    ready,
  ]
}

export function factsOf(m: MidSummary): MidFacts {
  return {
    agentAccess: m.agentAccess,
    state: m.state,
    activeJob: m.job && isActiveJobStatus(m.job.status) ? m.job.stage : null,
    instanceUrl: m.instanceUrl,
    configUrl: m.configUrl,
  }
}

/** MidError whose JSON body also carries the full checklist (see lib/mids/http.ts). */
export class AgentCheckError extends MidError {
  readonly checks: Check[]
  constructor(message: string, checks: Check[]) {
    super("agent_check_failed", 403, message)
    this.checks = checks
  }
}

/** The audit detail every agent.* entry starts with (spec 5.3); never carries the secret. */
export const agentAuditDetail = (caller: AgentCaller) => ({
  via: "agenthub" as const,
  taskId: caller.taskId,
  sessionInstances: caller.sessionInstances,
})

/** Loads the MID and requires every check to pass; failures are audited under the real actor and thrown. */
export async function requireUsableMid(caller: AgentCaller, name: string): Promise<MidSummary> {
  const mid = await getMid(name)
  const checks = evaluateChecks(caller, factsOf(mid))
  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) return mid
  await recordAudit(caller.user, "agent.check_failed", mid.name, {
    ...agentAuditDetail(caller),
    mid: mid.name,
    failed: failed.map((c) => c.id),
  })
  throw new AgentCheckError(failed[0].message ?? "MID นี้ยังไม่ผ่านเงื่อนไขสำหรับ AgentHub", checks)
}

/** For per-MID routes: name syntax first, then the full checklist (audited on failure); nothing else may run before. */
export async function usableMidParam(caller: AgentCaller, params: Promise<{ name: string }>): Promise<MidSummary> {
  return requireUsableMid(caller, validateMidName((await params).name))
}
