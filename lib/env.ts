import path from "node:path"
import { DEFAULT_MIDHUB_ROOT } from "@/lib/mids/names"

export interface Env {
  databaseUrl: string
  jwtSecret: string
  vaultKey: string
  midhubRoot: string
  jobsDir: string
  maxRunning: number
  helperSocket: string
  /** Shared secret for AgentHub's /api/agent/* calls; null = feature off. */
  agentSecret: string | null
  /** BSM AgentHub base URL (loopback only) asked for the signed-in user: GET <agenthubUrl>/api/auth/me. */
  agenthubUrl: string
  /** Account that must own AgentHub's TCP listener (lib/auth/listener-owner.ts); null = check disabled ("none"). */
  agenthubServiceUser: string | null
}

// ADMIN_EMAIL/ADMIN_PASSWORD are gone (sign-in is through AgentHub); old values left in .env.local are ignored.
const REQUIRED = ["JWT_SECRET", "MIDHUB_VAULT_KEY", "DATABASE_URL"] as const

// The AgentHub session cookie is forwarded to this URL, so it must stay on this host: plain http to a loopback
// address with an explicit port, nothing else (no path, credentials, query or fragment).
const AGENTHUB_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/

function agenthubUrlFrom(v: string | undefined): string {
  const raw = v || "http://127.0.0.1:3000"
  const m = AGENTHUB_URL_RE.exec(raw)
  const port = m ? Number(m[2]) : 0
  if (!m || port < 1 || port > 65535) {
    throw new Error("AGENTHUB_URL must be http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port> (AgentHub on this host)")
  }
  return raw.replace(/\/$/, "")
}

// Before every lookup, AGENTHUB_URL's TCP listener must belong to this account (anti port squatting). Only the
// literal "none" turns the check off (dev and tests); unset or empty means the production default.
const SERVICE_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

function agenthubServiceUserFrom(v: string | undefined): string | null {
  const raw = v || "bsmagenthub"
  if (raw === "none") return null
  if (!SERVICE_USER_RE.test(raw)) {
    throw new Error('AGENTHUB_SERVICE_USER must be a Linux user name (the account AgentHub runs as) or "none"')
  }
  return raw
}

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
    vaultKey: src.MIDHUB_VAULT_KEY as string,
    midhubRoot,
    jobsDir: path.join(midhubRoot, "jobs"),
    maxRunning,
    helperSocket: src.MIDHUB_HELPER_SOCKET || "/run/midhub/helper.sock",
    agentSecret,
    agenthubUrl: agenthubUrlFrom(src.AGENTHUB_URL),
    agenthubServiceUser: agenthubServiceUserFrom(src.AGENTHUB_SERVICE_USER),
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
