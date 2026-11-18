import fs from "node:fs"
import path from "node:path"
import { DEFAULT_MIDHUB_ROOT } from "../lib/mids/names"
import type { HandlerDeps } from "./handler"
import { createHelperServer } from "./server"
import { makeSystemctl, realExec } from "./systemctl"

const socketPath = process.env.MIDHUB_HELPER_SOCKET || "/run/midhub/helper.sock"
const group = process.env.MIDHUB_SOCKET_GROUP || "bsmmidhub"
const maxRunning = Number(process.env.MIDHUB_MAX_RUNNING || 4)
if (!Number.isInteger(maxRunning) || maxRunning < 1) throw new Error("MIDHUB_MAX_RUNNING must be a positive integer")

const deps: HandlerDeps = {
  systemctl: makeSystemctl(),
  exec: realExec,
  maxRunning,
  midhubRoot: process.env.MIDHUB_ROOT || DEFAULT_MIDHUB_ROOT,
}

function groupGid(name: string): number {
  for (const line of fs.readFileSync("/etc/group", "utf8").split("\n")) {
    const [n, , gid] = line.split(":")
    if (n === name && /^\d+$/.test(gid ?? "")) return Number(gid)
  }
  throw new Error(`group not found: ${name}`)
}

function main() {
  const gid = groupGid(group)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath)
    else throw new Error(`${socketPath} exists and is not a socket`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  const oldUmask = process.umask(0o177) // socket is created root-only; opened up to the group only after chown
  const server = createHelperServer(deps)
  server.listen(socketPath, () => {
    fs.chownSync(socketPath, 0, gid)
    fs.chmodSync(socketPath, 0o660)
    process.umask(oldUmask)
    console.log(`midhub-helper listening on ${socketPath} (root:${group} 0660)`)
  })
  server.on("error", (e) => {
    console.error(e)
    process.exit(1)
  })
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)))
}

main()
