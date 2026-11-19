// Guards the AgentHub lookup against loopback port squatting: AgentHub's port (3000) is unprivileged, so while
// AgentHub is down any local account could listen there, answer "admin" and collect the forwarded `session`
// cookies. Before every lookup the TCP listener for AGENTHUB_URL's port must belong to AGENTHUB_SERVICE_USER.
// /proc/net/tcp{,6} are world-readable and list each socket's owning uid; Node has no getpwnam, so the user's uid
// comes from /etc/passwd (cached for the process lifetime).
import fs from "node:fs/promises"

/** Swappable in tests (same pattern as lib/mids/registry.ts). */
export const deps = {
  readFile: (p: string): Promise<string> => fs.readFile(p, "utf8"),
}

const TCP_LISTEN = "0A"

// /proc prints each 32-bit word of an address in host byte order; every platform this runs on (x86_64, arm64)
// is little-endian, so 127.0.0.1 appears as 0100007F.
function wordBytes(hex8: string): number[] {
  const n = parseInt(hex8, 16)
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function v6Text(bytes: number[]): string {
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1])
  // Compress the longest run (>= 2) of zero groups, as inet_ntop does.
  let best = -1, bestLen = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen) { best = i; bestLen = j - i }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestLen < 2) return hex.join(":")
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`
}

/** "0100007F" -> "127.0.0.1"; 32 hex chars -> IPv6 text, with v4-mapped (::ffff:a.b.c.d) reduced to a.b.c.d. */
function procAddr(hex: string): string | null {
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) return wordBytes(hex).join(".")
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return null
  const bytes = [0, 8, 16, 24].flatMap((o) => wordBytes(hex.slice(o, o + 8)))
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join(".")
  return v6Text(bytes)
}

/**
 * Pure parser for /proc/net/tcp or /proc/net/tcp6 text: the uid of every LISTEN socket on `port` whose local
 * address is in `addrs` (textual: "127.0.0.1", "0.0.0.0", "::1", "::"; v4-mapped rows count as their v4 address).
 */
export function listenerUids(procNetText: string, port: number, addrs: Set<string>): number[] {
  const uids: number[] = []
  for (const line of procNetText.split("\n")) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
    const f = line.trim().split(/\s+/)
    if (f.length < 8 || !/^\d+:$/.test(f[0]) || f[3] !== TCP_LISTEN) continue
    const [addrHex, portHex] = f[1].split(":")
    if (!portHex || !/^[0-9A-Fa-f]{4}$/.test(portHex) || parseInt(portHex, 16) !== port) continue
    const addr = procAddr(addrHex)
    if (addr === null || !addrs.has(addr) || !/^\d+$/.test(f[7])) continue
    uids.push(Number(f[7]))
  }
  return uids
}

/** Local addresses that would accept a connection to AGENTHUB_URL's host (its loopback address or a wildcard). */
export function addrsForHost(hostname: string): Set<string> {
  if (hostname === "127.0.0.1") return new Set(["127.0.0.1", "0.0.0.0", "::"])
  if (hostname === "[::1]" || hostname === "::1") return new Set(["::1", "::"])
  // localhost may resolve to either family: every listener it could reach must be the service user's.
  return new Set(["127.0.0.1", "::1", "0.0.0.0", "::"])
}

/** Pure: uid of `user` in /etc/passwd text, or null. */
export function uidFromPasswd(passwdText: string, user: string): number | null {
  for (const line of passwdText.split("\n")) {
    const f = line.split(":")
    if (f.length >= 3 && f[0] === user && /^\d+$/.test(f[2])) return Number(f[2])
  }
  return null
}

const uidCache = new Map<string, number>()

/** The service user's uid, from /etc/passwd once per process. A missing user is a configuration error (throws). */
export async function serviceUid(user: string): Promise<number> {
  const hit = uidCache.get(user)
  if (hit !== undefined) return hit
  let uid: number | null = null
  try {
    uid = uidFromPasswd(await deps.readFile("/etc/passwd"), user)
  } catch {
    uid = null
  }
  if (uid === null) {
    throw new Error(`AGENTHUB_SERVICE_USER: user "${user}" not found in /etc/passwd (set it to the account AgentHub runs as, or "none" to disable the listener check in dev)`)
  }
  uidCache.set(user, uid)
  return uid
}

async function readProcNet(file: string, optional: boolean): Promise<string> {
  try {
    return await deps.readFile(file)
  } catch (err) {
    if (optional && (err as { code?: unknown }).code === "ENOENT") return "" // IPv6 disabled
    throw err
  }
}

/**
 * null when at least one TCP listener for `url`'s port is on its loopback address or a wildcard and every such
 * listener belongs to `user`; otherwise a cause for the log ("listener on :<port> not owned by <user> (...)").
 * Throws only for a configuration error (unknown user). Fails closed when /proc cannot be read.
 */
export async function listenerOwnerProblem(url: string, user: string): Promise<string | null> {
  const expected = await serviceUid(user)
  const u = new URL(url)
  const port = Number(u.port || 80)
  const prefix = `listener on :${port} not owned by ${user}`
  const addrs = addrsForHost(u.hostname)
  let uids: number[]
  try {
    const [v4, v6] = await Promise.all([readProcNet("/proc/net/tcp", false), readProcNet("/proc/net/tcp6", true)])
    uids = [...listenerUids(v4, port, addrs), ...listenerUids(v6, port, addrs)]
  } catch (err) {
    const code = (err as { code?: unknown }).code
    return `${prefix} (cannot read /proc/net/tcp: ${typeof code === "string" ? code : "error"})`
  }
  if (uids.length === 0) return `${prefix} (nothing listening)`
  const others = [...new Set(uids.filter((x) => x !== expected))]
  if (others.length) return `${prefix} (uid ${expected} expected, found uid ${others.join(", ")})`
  return null
}
