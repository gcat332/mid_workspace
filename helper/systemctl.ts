import { EXEC_TIMEOUT_MS } from "../lib/helper/protocol"
import {
  LIST_ACTIVE_ARGS,
  LIST_ENABLED_ARGS,
  listOutput,
  mapExecResult,
  parseActiveMidUnits,
  parseEnabledMidUnits,
  runFile,
  SYSTEMCTL,
  type RunResult,
} from "../lib/mids/unit-list"

export { SYSTEMCTL }
export const CHOWN = "/usr/bin/chown"
export const CHMOD = "/usr/bin/chmod"
export const SETPRIV = "/usr/bin/setpriv"

export type { RunResult }
export { mapExecResult, parseActiveMidUnits, parseEnabledMidUnits }
export type Exec = (file: string, args: string[]) => Promise<RunResult>
export type Systemctl = {
  run(args: string[]): Promise<RunResult>
  /** Units whose ActiveState is active, activating, reloading or deactivating. */
  activeMidUnits(): Promise<string[]>
  /** Units that are enabled (will come back at boot) whether or not they are running now. */
  enabledMidUnits(): Promise<string[]>
}

/** execFile with an argument array; never a shell. stdout includes stderr so callers can see failures. */
export const realExec: Exec = (file, args) => runFile(file, args, EXEC_TIMEOUT_MS)

export function makeSystemctl(exec: Exec = realExec): Systemctl {
  return {
    run: (args) => exec(SYSTEMCTL, args),
    async activeMidUnits() {
      const r = await exec(SYSTEMCTL, LIST_ACTIVE_ARGS)
      return parseActiveMidUnits(listOutput(r, "systemctl list-units"))
    },
    async enabledMidUnits() {
      const r = await exec(SYSTEMCTL, LIST_ENABLED_ARGS)
      return parseEnabledMidUnits(listOutput(r, "systemctl list-unit-files"))
    },
  }
}
