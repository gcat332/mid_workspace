import fs from "node:fs"
import path from "node:path"
import { env } from "@/lib/env"

const SECRET_KEY = /password/i

export function journalPath(jobId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("invalid job id")
  return path.join(env.jobsDir, `${jobId}.jsonl`)
}

// Defensive: journal lines are readable by members; never let a password-like field through.
export function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!SECRET_KEY.test(k)) out[k] = stripSecrets(val)
    }
    return out
  }
  return v
}

export async function appendJournal(jobId: string, entry: object): Promise<void> {
  const file = journalPath(jobId)
  await fs.promises.mkdir(env.jobsDir, { recursive: true, mode: 0o750 })
  const line = JSON.stringify({ t: new Date().toISOString(), ...(stripSecrets(entry) as object) })
  await fs.promises.appendFile(file, line + "\n", { mode: 0o640 })
}

export async function readJournal(jobId: string): Promise<object[]> {
  let text: string
  try {
    text = await fs.promises.readFile(journalPath(jobId), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
  const out: object[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as object)
    } catch {
      // torn last line after a crash: skip
    }
  }
  return out
}
