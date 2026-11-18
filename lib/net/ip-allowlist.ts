import { prisma } from "@/lib/db/client"
import { isLoopback, wouldAllow } from "@/lib/net/cidr"

export { isValidCidr, inCidr, isLoopback, clientIpFrom, wouldAllow } from "@/lib/net/cidr"

// Read straight from SQLite via prisma on every request (Next 16's proxy runs on the Node runtime,
// same as AgentHub). Deliberately NOT cached: the proxy and the admin route can be separate module
// instances, so a per-process cache would leave a change (or a lockout fix) stale for its TTL.
async function loadCidrs(): Promise<string[]> {
  const rows = await prisma.ipAllowlist.findMany({ select: { cidr: true } })
  return rows.map((r) => r.cidr)
}

// Loopback always allowed; an empty list is allow-all until configured.
export async function isAllowed(ip: string): Promise<boolean> {
  if (isLoopback(ip)) return true
  return wouldAllow(ip, await loadCidrs())
}
