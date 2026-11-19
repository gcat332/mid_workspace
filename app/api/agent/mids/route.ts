import { agentRoute } from "@/lib/agent/http"
import { evaluateChecks, factsOf } from "@/lib/agent/checks"
import { listMids } from "@/lib/mids/registry"
import { statusView } from "@/lib/ui/status-view"

/** Read-only and frequent: deliberately not audited (spec 5.3). */
export const GET = agentRoute(async (_req, caller) => {
  const mids = (await listMids()).map((m) => {
    const checks = evaluateChecks(caller, factsOf(m))
    const sv = statusView({
      state: m.state,
      status: { ...m.status, since: m.status.since ? m.status.since.toISOString() : null },
      job: m.job ? { ...m.job, createdAt: m.job.createdAt.toISOString() } : null,
    }, "th")
    return {
      name: m.name,
      snName: m.midName,
      instanceUrl: m.instanceUrl,
      status: sv.label,
      usable: checks.every((c) => c.ok),
      checks,
    }
  })
  return Response.json({ mids })
})
