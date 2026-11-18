import { prisma } from "@/lib/db/client"

/**
 * Boot-time repair: a MID in state installing/uninstalling with no queued/running/failed job for its name
 * was orphaned by a crash between the row write and createJob. Mark it "error" so it can be cleaned up in the UI.
 * Returns the names that were repaired. Run after resumeJobs (resumed jobs are queued/running and count as active).
 */
export async function reconcileOrphanedMids(): Promise<string[]> {
  const rows = await prisma.midServer.findMany({ where: { state: { in: ["installing", "uninstalling"] } }, select: { name: true, state: true } })
  const fixed: string[] = []
  for (const r of rows) {
    const job = await prisma.job.findFirst({ where: { midName: r.name, status: { in: ["queued", "running", "failed"] } }, select: { id: true } })
    if (job) continue
    const res = await prisma.midServer.updateMany({ where: { name: r.name, state: r.state }, data: { state: "error" } })
    if (res.count !== 1) continue
    fixed.push(r.name)
    console.error(`[boot] MID ${r.name} was ${r.state} with no job; marked error`)
    try {
      await prisma.auditLog.create({
        data: { userId: null, email: "system", action: "mid.reconcile", midName: r.name, detail: JSON.stringify({ from: r.state, to: "error" }) },
      })
    } catch (e) {
      console.error("[boot] audit write failed:", e instanceof Error ? e.message : "unknown")
    }
  }
  return fixed
}
