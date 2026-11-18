import { prisma } from "@/lib/db/client"
import { isLoopback, wouldAllow } from "@/lib/net/cidr"

export { isValidCidr, inCidr, isLoopback, clientIpFrom, wouldAllow } from "@/lib/net/cidr"

// Read straight from SQLite via prisma: Next 16's proxy runs on the Node runtime (same as AgentHub).
let cache: { cidrs: string[]; at: number } | null = null
const TTL_MS = 30_000

export function bustAllowlistCache(): void { cache = null }

async function loadCidrs(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cidrs
  const rows = await prisma.ipAllowlist.findMany({ select: { cidr: true } })
  cache = { cidrs: rows.map((r) => r.cidr), at: Date.now() }
  return cache.cidrs
}

// Loopback always allowed; an empty list is allow-all until configured.
export async function isAllowed(ip: string): Promise<boolean> {
  if (isLoopback(ip)) return true
  return wouldAllow(ip, await loadCidrs())
}
