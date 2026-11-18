import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { env } from "@/lib/env"

// AES-256-GCM vault for ServiceNow credentials (copied from AgentHub). Key: MIDHUB_VAULT_KEY, 32 bytes base64.
const ALGO = "aes-256-gcm"

function vaultKey(): Buffer {
  const key = Buffer.from(env.vaultKey, "base64")
  if (key.length !== 32) {
    throw new Error("MIDHUB_VAULT_KEY must be base64 of exactly 32 bytes (generate with: openssl rand -base64 32)")
  }
  return key
}

// iv:tag:ciphertext, each base64url. A fresh 96-bit IV per call (never reused with one key).
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, vaultKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(":")
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(":")
  if (parts.length !== 3) throw new Error("malformed secret blob")
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url"))
  if (iv.length !== 12 || tag.length !== 16) throw new Error("malformed secret blob")
  const decipher = createDecipheriv(ALGO, vaultKey(), iv)
  decipher.setAuthTag(tag) // a tampered ciphertext/tag throws in final() — fail closed
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}
