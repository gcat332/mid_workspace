import fs from "node:fs/promises"
import path from "node:path"
import { MidError, midRoot, unitName, validateMidName } from "../lib/mids/names"
import { HELPER_OPS, type HelperResponse } from "../lib/helper/protocol"
import { renderUnit } from "./unit-template"
import { CHMOD, CHOWN, SETPRIV, type Exec, type Systemctl } from "./systemctl"

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

// Requests run strictly one at a time so the quota check and the start are atomic. The queue is bounded.
export const MAX_PENDING = 32
let tail: Promise<unknown> = Promise.resolve()
let pending = 0
export function handleRequest(req: unknown, deps: HandlerDeps): Promise<HelperResponse> {
  if (pending >= MAX_PENDING) return Promise.resolve(fail("busy", "too many pending requests"))
  pending++
  const p = tail.then(() => run(req, deps))
  tail = p.then(
    () => void pending--,
    () => void pending--,
  )
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
    return fail("internal", e instanceof Error ? e.message : "unexpected error")
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
  const [active, enabled] = await Promise.all([deps.systemctl.activeMidUnits(), deps.systemctl.enabledMidUnits()])
  // Enabled-but-inactive units count too: they come back at boot, so they would exceed the cap after a reboot.
  const others = new Set([...active, ...enabled])
  others.delete(unit)
  if (others.size >= deps.maxRunning) return fail("quota_full", `max ${deps.maxRunning} MIDs running`)
  if (op === "start") {
    // Already running: still enable so it comes back after reboot.
    if (active.includes(unit)) return (await sc(deps, ["enable", unit])) ?? OK
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
  const tmpFile = path.join(path.dirname(file), `.${unitName(name)}.${process.pid}.tmp`)
  try {
    await fs.writeFile(tmpFile, content, { mode: 0o644, flag: "w" })
    await fs.chmod(tmpFile, 0o644)
    await fs.rename(tmpFile, file)
  } catch (e) {
    await fs.rm(tmpFile, { force: true })
    throw e
  }
  return (await sc(deps, ["daemon-reload"])) ?? OK
}

const NOT_LOADED_RE = /not loaded|does not exist|No such file/i

async function removeUnit(name: string, deps: HandlerDeps): Promise<HelperResponse> {
  const unit = unitName(name)
  // Only "not loaded / not found" results are ignorable; anything else keeps the unit file so state stays consistent.
  for (const verb of ["stop", "disable"]) {
    const r = await deps.systemctl.run([verb, unit])
    if (r.code !== 0 && r.code !== 5 && !NOT_LOADED_RE.test(r.stdout)) {
      return fail("systemctl_failed", `systemctl ${verb} failed (code ${r.code}): ${r.stdout.trim().slice(0, 500)}`)
    }
  }
  await fs.rm(unitPath(name, deps), { force: true })
  return (await sc(deps, ["daemon-reload"])) ?? OK
}

/** Failing command + tail of its output (stdout includes stderr), <= 300 chars; the dir path is the only variable part. */
function failDetail(cmd: string, r: { code: number; stdout: string }): string {
  const head = `${cmd} -R failed (code ${r.code}): `
  const out = r.stdout.trim().replace(/\s+/g, " ")
  return head + (out.length > 300 - head.length ? "..." + out.slice(-(300 - head.length - 3)) : out)
}

function onlyVanished(out: string): boolean {
  const lines = out.split("\n").filter((l) => l.trim() !== "")
  return lines.length > 0 && lines.every((l) => /: No such file or directory$/.test(l.trim()))
}

async function fixOwnership(name: string, deps: HandlerDeps): Promise<HelperResponse> {
  // SECURITY: <root>/mids is group-writable by the app group, so the app user could swap mids/<name> for a symlink
  // (e.g. to /etc) and have this root process chown it. Refuse unless every component is a real directory.
  // Residual TOCTOU: the entry could still be swapped between this check and chown. chown -P -h does not follow
  // symlinks (operand or met during traversal), which limits the damage; the top-level path is not pinned by fd.
  // GNU chmod DOES follow a symlink given as its operand, so chmod runs unprivileged (as midsvc:midhub) instead:
  // a redirected target then can only be touched where midsvc already has rights.
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
  const chown = await deps.exec(CHOWN, ["-R", "-P", "-h", "midsvc:midhub", dir])
  if (chown.code !== 0) return fail("fix_ownership_failed", failDetail("chown", chown))
  const chmod = await deps.exec(SETPRIV, ["--reuid=midsvc", "--regid=midhub", "--clear-groups", CHMOD, "-R", "g+rwX", "--", dir])
  // The running MID creates/deletes files while chmod -R walks the tree: a vanished entry makes GNU chmod exit 1 with
  // only "No such file or directory" lines. That is harmless (nothing left to chmod), so only that case is tolerated.
  if (chmod.code !== 0 && !onlyVanished(chmod.stdout)) return fail("fix_ownership_failed", failDetail("chmod", chmod))
  return OK
}
