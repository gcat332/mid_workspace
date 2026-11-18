import net from "node:net"
import { MAX_REQUEST_BYTES, READ_DEADLINE_MS, type HelperResponse } from "../lib/helper/protocol"
import { handleRequest, type HandlerDeps } from "./handler"

export const MAX_CONNECTIONS = 16

function reply(sock: net.Socket, res: HelperResponse) {
  sock.end(JSON.stringify(res) + "\n")
}

/** One JSON line in, one JSON line out, close. The read deadline is absolute (not idle) and ends once a full line arrives. */
export function createHelperServer(deps: HandlerDeps, opts: { readDeadlineMs?: number } = {}): net.Server {
  const deadlineMs = opts.readDeadlineMs ?? READ_DEADLINE_MS
  const server = net.createServer((sock) => {
    let buf = ""
    let done = false
    const deadline = setTimeout(() => sock.destroy(), deadlineMs)
    sock.on("close", () => clearTimeout(deadline))
    sock.on("error", () => sock.destroy())
    const finish = async (line: string) => {
      if (done) return
      done = true
      clearTimeout(deadline)
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
        clearTimeout(deadline)
        return reply(sock, { ok: false, code: "invalid_request", message: "request too large" })
      }
      if (nl !== -1) void finish(buf.slice(0, nl))
    })
    sock.on("end", () => {
      if (!done) void finish(buf)
    })
  })
  server.maxConnections = MAX_CONNECTIONS
  return server
}
