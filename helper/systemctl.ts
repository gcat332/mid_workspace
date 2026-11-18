import { execFile } from "node:child_process"

export type RunResult = { code: number; stdout: string }
export type Exec = (file: string, args: string[]) => Promise<RunResult>
export type Systemctl = {
  run(args: string[]): Promise<RunResult>
  activeMidUnits(): Promise<string[]>
}

/** execFile with an argument array; never a shell. stdout includes stderr so callers can see failures. */
export const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0
      resolve({ code, stdout: `${stdout}${stderr}` })
    })
  })

const UNIT_RE = /^midhub-mid-[a-z0-9][a-z0-9-]{1,39}\.service$/
const COUNTED = new Set(["active", "activating", "reloading"])

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
    run: (args) => exec("systemctl", args),
    async activeMidUnits() {
      const r = await exec("systemctl", ["list-units", "midhub-mid-*", "--all", "--plain", "--no-legend", "--no-pager"])
      if (r.code !== 0) throw new Error("systemctl list-units failed")
      return parseActiveMidUnits(r.stdout)
    },
  }
}
