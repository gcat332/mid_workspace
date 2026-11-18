// Free of Next/Prisma/env imports: shared by the root helper (helper/systemctl.ts) and the web app (lib/mids/status.ts).
// Both must count MID units exactly the same way so the UI never disagrees with the helper's quota.

export type RunResult = { code: number; stdout: string }

/** Pure mapping of an execFile callback result. Real numeric exit codes are kept; anything else (timeout kill,
 * signal, spawn error, maxBuffer overflow) becomes -1 with the cause in the output, so it can never look like exit 1. */
export function mapExecResult(
  err: (Error & { code?: unknown; signal?: string | null; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
): RunResult {
  if (!err) return { code: 0, stdout: `${stdout}${stderr}` }
  if (typeof err.code === "number") return { code: err.code, stdout: `${stdout}${stderr}` }
  const cause = `[exec error: ${err.signal ?? err.code ?? err.message}${err.killed ? " (killed)" : ""}]`
  return { code: -1, stdout: `${stdout}${stderr}${cause}` }
}

const UNIT_RE = /^midhub-mid-[a-z0-9][a-z0-9-]{1,39}\.service$/
const COUNTED = new Set(["active", "activating", "reloading", "deactivating"])

export const LIST_ACTIVE_ARGS = ["list-units", "midhub-mid-*", "--all", "--plain", "--no-legend", "--no-pager"]
export const LIST_ENABLED_ARGS = ["list-unit-files", "midhub-mid-*", "--state=enabled", "--no-legend", "--plain", "--no-pager"]

/** Parses `systemctl list-unit-files --state=enabled --plain --no-legend`: UNIT STATE [PRESET]. */
export function parseEnabledMidUnits(out: string): string[] {
  const units: string[] = []
  for (const line of out.split("\n")) {
    const [unit, state] = line.trim().split(/\s+/)
    if (UNIT_RE.test(unit ?? "") && state === "enabled") units.push(unit)
  }
  return units
}

/** Parses `systemctl list-units --all --plain --no-legend` text: UNIT LOAD ACTIVE SUB DESCRIPTION. */
export function parseActiveMidUnits(out: string): string[] {
  const units: string[] = []
  for (const line of out.split("\n")) {
    const cols = line.replace(/^[\s●*×]+/, "").trim().split(/\s+/)
    if (cols.length < 3) continue
    const [unit, , active] = cols
    if (UNIT_RE.test(unit) && COUNTED.has(active)) units.push(unit)
  }
  return units
}

/** systemctl list-* exits 1 with empty output (or "0 unit files listed") when nothing matches; that is not an error. */
export function listOutput(r: RunResult, what: string): string {
  if (r.code === 0) return r.stdout
  if (r.code === 1 && (r.stdout.trim() === "" || /^0 (unit files|units) listed\.?$/.test(r.stdout.trim()))) return ""
  throw new Error(`${what} failed (code ${r.code}): ${r.stdout.trim().slice(0, 200)}`)
}
