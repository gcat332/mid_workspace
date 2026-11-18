import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { unitName } from "./names"
import {
  LIST_ACTIVE_ARGS,
  LIST_ENABLED_ARGS,
  listOutput,
  mapExecResult,
  parseActiveMidUnits,
  parseEnabledMidUnits,
  type RunResult,
} from "./unit-list"

const SYSTEMCTL = "/usr/bin/systemctl"
const EXEC_TIMEOUT_MS = 10_000

export type ServiceStatus = {
  state: "running" | "stopped" | "failed" | "starting" | "unknown"
  pid: number | null
  memoryBytes: number | null
  since: Date | null
}

function parseProps(out: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of out.split("\n")) {
    const i = line.indexOf("=")
    if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return props
}

/**
 * Maps systemd ActiveState to our state union. `reloading` and `deactivating` map to "running": the process
 * is still alive, its memory is still in use and it still occupies one of the MID slots.
 */
function mapState(active: string): ServiceStatus["state"] {
  switch (active) {
    case "active":
    case "reloading":
    case "deactivating":
      return "running"
    case "activating":
      return "starting"
    case "inactive":
      return "stopped"
    case "failed":
      return "failed"
    default:
      return "unknown"
  }
}

/**
 * Parses systemd timestamps such as "Wed 2026-11-18 19:07:57 +07" (also "+0700", "+07:00", "UTC", "ICT",
 * fractional seconds, no weekday). Numeric offsets and UTC/GMT/Z are honoured; any other zone abbreviation
 * is ambiguous, so the time is read as host-local time (systemd prints it in the host's zone).
 */
export function parseSystemdTimestamp(raw: string | undefined): Date | null {
  const s = (raw ?? "").trim()
  if (s === "" || s === "n/a") return null
  const m = /^(?:[A-Za-z]{3}\s+)?(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(.*)$/.exec(s)
  if (!m) return null
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null
  const zone = m[7].trim()
  let date: Date
  const off = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone)
  if (off) {
    const minutes = (Number(off[2]) * 60 + Number(off[3] ?? 0)) * (off[1] === "-" ? -1 : 1)
    date = new Date(Date.UTC(y, mo - 1, d, h, mi, se) - minutes * 60_000)
  } else if (/^(UTC|GMT|Z)$/i.test(zone)) {
    date = new Date(Date.UTC(y, mo - 1, d, h, mi, se))
  } else {
    date = new Date(y, mo - 1, d, h, mi, se)
  }
  return Number.isNaN(date.getTime()) ? null : date
}

/** Parses `systemctl show --property=ActiveState,SubState,MainPID,MemoryCurrent,ActiveEnterTimestamp` output. */
export function parseSystemctlShow(out: string): ServiceStatus {
  const p = parseProps(out)
  const pid = Number(p.MainPID)
  // "[not set]" (accounting off) and uint64 max (not available) both mean "unknown".
  const mem = /^\d+$/.test(p.MemoryCurrent ?? "") ? Number(p.MemoryCurrent) : NaN
  return {
    state: mapState(p.ActiveState ?? ""),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    memoryBytes: Number.isSafeInteger(mem) ? mem : null,
    since: parseSystemdTimestamp(p.ActiveEnterTimestamp),
  }
}

/** execFile wrapper for unprivileged systemctl calls (fixed binary, argument array, timeout). */
export function runSystemctl(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(SYSTEMCTL, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(mapExecResult(err, stdout, stderr))
    })
  })
}

export async function readServiceStatus(name: string): Promise<ServiceStatus> {
  const unit = unitName(name) // validates the name first
  const r = await runSystemctl(["show", unit, "--property=ActiveState,SubState,MainPID,MemoryCurrent,ActiveEnterTimestamp"])
  if (r.code !== 0) throw new Error(`systemctl show failed (code ${r.code}): ${r.stdout.trim().slice(0, 200)}`)
  return parseSystemctlShow(r.stdout)
}

export type HostMemory = { totalBytes: number; availableBytes: number }

/** Parses /proc/meminfo (values in kB) into bytes. */
export function parseMeminfo(text: string): HostMemory {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text)
    if (!m) throw new Error(`/proc/meminfo is missing ${key}`)
    return Number(m[1]) * 1024
  }
  return { totalBytes: kb("MemTotal"), availableBytes: kb("MemAvailable") }
}

export async function readHostMemory(): Promise<HostMemory> {
  return parseMeminfo(await readFile("/proc/meminfo", "utf8"))
}

export type SlotUsage = {
  /** MID units that are alive (active/activating/reloading/deactivating). */
  running: number
  /** Same union the root helper enforces its quota over: enabled unit files + alive units. */
  quotaUsed: number
}

/** Counts MID slots unprivileged, with the exact commands and parsers the helper uses for its quota. */
export async function readSlotUsage(): Promise<SlotUsage> {
  const [active, enabled] = await Promise.all([runSystemctl(LIST_ACTIVE_ARGS), runSystemctl(LIST_ENABLED_ARGS)])
  const alive = parseActiveMidUnits(listOutput(active, "systemctl list-units"))
  const on = parseEnabledMidUnits(listOutput(enabled, "systemctl list-unit-files"))
  return { running: alive.length, quotaUsed: new Set([...alive, ...on]).size }
}
