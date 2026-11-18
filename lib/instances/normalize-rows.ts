import { prisma } from "@/lib/db/client"
import { normalizeInstanceUrl } from "./url"

/**
 * Idempotent startup step: Phase 1 imports stored Instance urls without a trailing slash. Rewrites every
 * valid ServiceNow url to its canonical form; rows that collapse together are merged (keep the one with
 * credentials, else the oldest; MidServers are repointed). Invalid urls are left alone.
 */
export async function normalizeInstanceRows(): Promise<number> {
  const rows = await prisma.instance.findMany({ orderBy: { createdAt: "asc" } })
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    let canon: string
    try { canon = normalizeInstanceUrl(r.url) } catch { continue }
    groups.set(canon, [...(groups.get(canon) ?? []), r])
  }
  let changed = 0
  for (const [canon, g] of groups) {
    if (g.length === 1 && g[0].url === canon) continue
    await prisma.$transaction(async (tx) => {
      const keeper = g.find((r) => r.midPasswordEnc) ?? g[0]
      for (const r of g) {
        if (r.id === keeper.id) continue
        await tx.midServer.updateMany({ where: { instanceId: r.id }, data: { instanceId: keeper.id } })
        await tx.instance.delete({ where: { id: r.id } })
      }
      await tx.instance.update({ where: { id: keeper.id }, data: { url: canon } })
    })
    changed += g.length
  }
  return changed
}
