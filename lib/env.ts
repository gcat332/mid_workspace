import path from "node:path"
import { DEFAULT_MIDHUB_ROOT } from "@/lib/mids/names"

export interface Env {
  databaseUrl: string
  jwtSecret: string
  adminEmail: string
  adminPassword: string
  vaultKey: string
  midhubRoot: string
  jobsDir: string
  maxRunning: number
  helperSocket: string
  /** Shared secret for AgentHub's /api/agent/* calls; null = feature off. */
  agentSecret: string | null
}

const REQUIRED = ["JWT_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD", "MIDHUB_VAULT_KEY", "DATABASE_URL"] as const

export function loadEnv(src: Record<string, string | undefined>): Env {
  const missing = REQUIRED.filter((k) => !src[k])
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }
  const jwtSecret = src.JWT_SECRET as string
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters")
  }
  const maxRunning = src.MIDHUB_MAX_RUNNING ? Number(src.MIDHUB_MAX_RUNNING) : 4
  if (!Number.isInteger(maxRunning) || maxRunning < 1) {
    throw new Error("MIDHUB_MAX_RUNNING must be a positive integer")
  }
  const agentSecret = src.MIDHUB_AGENT_SECRET || null
  if (agentSecret !== null && agentSecret.length < 32) {
    throw new Error("MIDHUB_AGENT_SECRET must be at least 32 characters (or unset to disable the AgentHub API)")
  }
  const midhubRoot = src.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT
  return {
    databaseUrl: src.DATABASE_URL as string,
    jwtSecret,
    adminEmail: (src.ADMIN_EMAIL as string).toLowerCase(),
    adminPassword: src.ADMIN_PASSWORD as string,
    vaultKey: src.MIDHUB_VAULT_KEY as string,
    midhubRoot,
    jobsDir: path.join(midhubRoot, "jobs"),
    maxRunning,
    helperSocket: src.MIDHUB_HELPER_SOCKET || "/run/midhub/helper.sock",
    agentSecret,
  }
}

let cached: Env | undefined
// Lazy: validated on first property access so importing this module (e.g. in tests) never throws.
export const env: Env = new Proxy({} as Env, {
  get(_t, prop) {
    cached ??= loadEnv(process.env)
    return cached[prop as keyof Env]
  },
})
