import { agentRoute } from "@/lib/agent/http"
import { agentAuditDetail, usableMidParam } from "@/lib/agent/checks"
import { recordAudit } from "@/lib/audit"
import { callHelper } from "@/lib/helper/client"
import { lowMemoryResponse, startNeedsMemory } from "@/lib/mids/memory-guard"

type Ctx = { params: Promise<{ name: string }> }

/**
 * POST -> { ok: true } (spec 5.3). Same as the browser's restart action: helper op `restart` (which also starts a
 * stopped MID and enforces the quota), low-RAM check when the MID is not running. There is no confirm from the agent
 * side, so `low_memory` 409 is final here; any request body is ignored.
 */
export const POST = agentRoute<Ctx>(async (_req, caller, ctx) => {
  const mid = await usableMidParam(caller, ctx.params)
  if (startNeedsMemory("restart", mid.status.state)) {
    const low = await lowMemoryResponse("หยุด MID ที่ไม่ใช้ก่อน หรือให้ผู้ใช้ start เองในหน้า MidHub")
    if (low) return low
  }
  const detail = agentAuditDetail(caller)
  try {
    await callHelper({ op: "restart", name: mid.name })
  } catch (e) {
    await recordAudit(caller.user, "agent.restart", mid.name, { ...detail, ok: false, code: (e as { code?: string }).code ?? "internal" })
    throw e
  }
  await recordAudit(caller.user, "agent.restart", mid.name, detail)
  return Response.json({ ok: true })
})
