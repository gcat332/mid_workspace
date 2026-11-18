import fs from "node:fs/promises"
import path from "node:path"
import { MidError, midRoot, unitName, validateMidName } from "../lib/mids/names"
import { HELPER_OPS, type HelperResponse } from "../lib/helper/protocol"
import { renderUnit } from "./unit-template"
import type { Exec, Systemctl } from "./systemctl"

export type HandlerDeps = {
  systemctl: Systemctl
  exec: Exec
  maxRunning: number
  midhubRoot: string
  systemdDir?: string
}

const DEFAULT_SYSTEMD_DIR = "/etc/systemd/system"

const fail = (code: Extract<HelperResponse, { ok: false }>["code"], message: string): HelperResponse => ({ ok: false, code, message })
const OK: HelperResponse = { ok: true }

// Requests run strictly one at a time so the quota check and the start are atomic.
let tail: Promise<unknown> = Promise.resolve()
export function handleRequest(req: unknown, deps: HandlerDeps): Promise<HelperResponse> {
  const p = tail.then(() => run(req, deps))
  tail = p.catch(() => undefined)
  return p
}

async function run(req: unknown, deps: HandlerDeps): Promise<HelperResponse> {
  try {
    if (typeof req !== "object" || req === null || Array.isArray(req)) return fail("invalid_request", "request must be an object")
    const r = req as Record<string, unknown>
    const op = r.op
    if (typeof op !== "string" || !(HELPER_OPS as readonly string[]).includes(op)) return fail("invalid_request", "unknown op")
    const allowed = op === "installUnit" ? ["op", "name", "heapMb"] : ["op", "name"]
    if (Object.keys(r).some((k) => !allowed.includes(k))) return fail("invalid_request", "unexpected fields")
    if (typeof r.name !== "string") return fail("invalid_request", "name must be a string")
    const name = validateMidName(r.name)
    switch (op) {
      case "start":
      case "restart":
        return await startLike(op, name, deps)
      case "stop":
        return await stop(name, deps)
      case "installUnit":
        return await installUnit(name, r.heapMb, deps)
      case "removeUnit":
        return await removeUnit(name, deps)
      default:
        return await fixOwnership(name, deps)
    }
  } catch (e) {
    if (e instanceof MidError) return fail(e.code === "invalid_name" ? "invalid_name" : "invalid_request", e.message)
    return fail("systemctl_failed", e instanceof Error ? e.message : "unexpected error")
  }
}

const unitPath = (name: string, deps: HandlerDeps) => path.join(deps.systemdDir ?? DEFAULT_SYSTEMD_DIR, unitName(name))

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

async function sc(deps: HandlerDeps, args: string[]): Promise<HelperResponse | null> {
  const r = await deps.systemctl.run(args)
  return r.code === 0 ? null : fail("systemctl_failed", `systemctl ${args[0]} failed (code ${r.code}): ${r.stdout.trim().slice(0, 500)}`)
}

async function startLike(op: "start" | "restart", name: string, deps: HandlerDeps): Promise<HelperResponse> {
  const unit = unitName(name)
  if (!(await exists(unitPath(name, deps)))) return fail("not_found", "unit is not installed")
  const active = await deps.systemctl.activeMidUnits()
  const alreadyActive = active.includes(unit)
  if (!alreadyActive && active.length >= deps.maxRunning) return fail("quota_full", `max ${deps.maxRunning} MIDs running`)
  if (op === "start") {
    if (alreadyActive) return OK
    return (await sc(deps, ["enable", unit])) ?? (await sc(deps, ["start", unit])) ?? OK
  }
  return (await sc(deps, ["enable", unit])) ?? (await sc(deps, ["restart", unit])) ?? OK
}

async function stop(name: string, deps: HandlerDeps): Promise<HelperResponse> {
  const unit = unitName(name)
  if (!(await exists(unitPath(name, deps)))) return fail("not_found", "unit is not installed")
  return (await sc(deps, ["disable", unit])) ?? (await sc(deps, ["stop", unit])) ?? OK
}

async function installUnit(name: string, heapMb: unknown, deps: HandlerDeps): Promise<HelperResponse> {
  if (typeof heapMb !== "number") return fail("invalid_request", "heapMb must be a number")
  const content = renderUnit({ name, heapMb, midRoot: midRoot(name, deps.midhubRoot) })
  const file = unitPath(name, deps)
  await fs.writeFile(file, content, { mode: 0o644 })
  await fs.chmod(file, 0o644)
  return (await sc(deps, ["daemon-reload"])) ?? OK
}

async function removeUnit(name: string, deps: HandlerDeps): Promise<HelperResponse> {
  const unit = unitName(name)
  // Failures here are expected when the unit is not loaded / not enabled; the file removal is what matters.
  await deps.systemctl.run(["stop", unit])
  await deps.systemctl.run(["disable", unit])
  await fs.rm(unitPath(name, deps), { force: true })
  return (await sc(deps, ["daemon-reload"])) ?? OK
}

async function fixOwnership(name: string, deps: HandlerDeps): Promise<HelperResponse> {
  // SECURITY: <root>/mids is group-writable by the app group, so the app user could swap mids/<name> for a symlink
  // (e.g. to /etc) and have this root process chown it. Refuse unless every component is a real directory.
  // Residual TOCTOU: the entry could still be swapped between this check and chown/chmod. chown -P -h does not
  // follow symlinks met during traversal, which limits the damage, but the top-level path is not pinned by fd.
  const dir = midRoot(name, deps.midhubRoot)
  const mids = path.join(deps.midhubRoot, "mids")
  for (const p of [mids, dir]) {
    let st
    try {
      st = await fs.lstat(p)
    } catch {
      return fail("not_found", "MID directory not found")
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return fail("invalid_request", "refusing: not a real directory")
  }
  if ((await fs.realpath(dir)) !== path.resolve(dir)) return fail("invalid_request", "refusing: path resolves elsewhere")
  const chown = await deps.exec("chown", ["-R", "-P", "-h", "midsvc:midhub", dir])
  if (chown.code !== 0) return fail("systemctl_failed", `chown failed: ${chown.stdout.trim().slice(0, 500)}`)
  const chmod = await deps.exec("chmod", ["-R", "g+rwX", dir])
  if (chmod.code !== 0) return fail("systemctl_failed", `chmod failed: ${chmod.stdout.trim().slice(0, 500)}`)
  return OK
}
