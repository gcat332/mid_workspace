import { prisma } from "@/lib/db/client"

export interface IdpConfigData {
  provider: string
  label: string
  enabled: boolean
  issuer: string
  clientId: string
  clientSecret: string
  tenantId: string
  redirectUri: string
  scopes: string
}

// Single-row IdP config. The client secret is stored as-is in the DB, same as AgentHub.
export const idpService = {
  get: () => prisma.idpConfig.findFirst({ orderBy: { createdAt: "asc" } }),

  async status(): Promise<{ enabled: boolean; label: string }> {
    const c = await idpService.get()
    return { enabled: c?.enabled ?? false, label: c?.label ?? "SSO" }
  },

  async upsert(data: Partial<IdpConfigData>): Promise<void> {
    const existing = await idpService.get()
    if (existing) await prisma.idpConfig.update({ where: { id: existing.id }, data })
    else await prisma.idpConfig.create({ data })
  },
}
