import { execFile } from "node:child_process"
import { EXEC_TIMEOUT_MS } from "../lib/helper/protocol"

export const SYSTEMCTL = "/usr/bin/systemctl"
export const CHOWN = "/usr/bin/chown"
export const CHMOD = "/usr/bin/chmod"
export const SETPRIV = "/usr/bin/setpriv"

export type RunResult = { code: number; stdout: string }
export type Exec = (file: string, args: string[]) => Promise<RunResult>
export type Systemctl = {
  run(args: string[]): Promise<RunResult>
  /** Units whose ActiveState is active, activating, reloading or deactivating. */
  activeMidUnits(): Promise<string[]>
  /** Units that are enabled (will come back at boot) whether or not they are running now. */
  enabledMidUnits(): Promise<string[]>
}

/** execFile with an argument array; never a shell. stdout includes stderr so callers can see failures. */
export const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0
      resolve({ code, stdout: `${stdout}${stderr}` })
    })
  })

const UNIT_RE = /^midhub-mid-[a-z0-9][a-z0-9-]{1,39}\.service$/
const COUNTED = new Set(["active", "activating", "reloading", "deactivating"])

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

export function makeSystemctl(exec: Exec = realExec): Systemctl {
  return {
    run: (args) => exec(SYSTEMCTL, args),
    async activeMidUnits() {
      const r = await exec(SYSTEMCTL, ["list-units", "midhub-mid-*", "--all", "--plain", "--no-legend", "--no-pager"])
      if (r.code !== 0) throw new Error("systemctl list-units failed")
      return parseActiveMidUnits(r.stdout)
    },
    async enabledMidUnits() {
      const r = await exec(SYSTEMCTL, ["list-unit-files", "midhub-mid-*", "--state=enabled", "--no-legend", "--plain", "--no-pager"])
      if (r.code !== 0) throw new Error("systemctl list-unit-files failed")
      return parseEnabledMidUnits(r.stdout)
    },
  }
}
