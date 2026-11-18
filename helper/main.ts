import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { DEFAULT_MIDHUB_ROOT } from "../lib/mids/names"
import { MAX_REQUEST_BYTES, type HelperResponse } from "../lib/helper/protocol"
import { handleRequest, type HandlerDeps } from "./handler"
import { makeSystemctl, realExec } from "./systemctl"

const CONN_TIMEOUT_MS = 10_000

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

function reply(sock: net.Socket, res: HelperResponse) {
  sock.end(JSON.stringify(res) + "\n")
}

function onConnection(sock: net.Socket) {
  sock.setTimeout(CONN_TIMEOUT_MS, () => sock.destroy())
  sock.on("error", () => sock.destroy())
  let buf = ""
  let done = false
  const finish = async (line: string) => {
    if (done) return
    done = true
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return reply(sock, { ok: false, code: "invalid_request", message: "malformed JSON" })
    }
    reply(sock, await handleRequest(parsed, deps))
  }
  sock.setEncoding("utf8")
  sock.on("data", (chunk: string) => {
    if (done) return
    buf += chunk
    const nl = buf.indexOf("\n")
    const lineLen = nl === -1 ? buf.length : nl
    if (Buffer.byteLength(buf.slice(0, lineLen)) > MAX_REQUEST_BYTES) {
      done = true
      return reply(sock, { ok: false, code: "invalid_request", message: "request too large" })
    }
    if (nl !== -1) void finish(buf.slice(0, nl))
  })
  sock.on("end", () => {
    if (!done) void finish(buf)
  })
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
  process.umask(0o177) // socket is created root-only; opened up to the group only after chown
  const server = net.createServer(onConnection)
  server.listen(socketPath, () => {
    fs.chownSync(socketPath, 0, gid)
    fs.chmodSync(socketPath, 0o660)
    console.log(`midhub-helper listening on ${socketPath} (root:${group} 0660)`)
  })
  server.on("error", (e) => {
    console.error(e)
    process.exit(1)
  })
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)))
}

main()
