import net from "node:net"
import { env } from "@/lib/env"
import { MidError } from "@/lib/mids/names"
import type { HelperRequest, HelperResponse } from "./protocol"

const TIMEOUT_MS = 30_000
const HELPER_DOWN = "ตัวช่วยระบบ (midhub-helper) ไม่ทำงาน กรุณาแจ้ง Admin"

function roundTrip(req: HelperRequest, socketPath: string): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath)
    let buf = ""
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      sock.destroy()
      fn()
    }
    sock.setEncoding("utf8")
    sock.setTimeout(TIMEOUT_MS, () => settle(() => reject(new MidError("helper_down", 503, HELPER_DOWN))))
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (c: string) => (buf += c))
    sock.on("error", (e: NodeJS.ErrnoException) =>
      settle(() => reject(["ENOENT", "ECONNREFUSED", "EACCES"].includes(e.code ?? "") ? new MidError("helper_down", 503, HELPER_DOWN) : e)),
    )
    sock.on("close", () =>
      settle(() => {
        try {
          resolve(JSON.parse(buf) as HelperResponse)
        } catch {
          reject(new MidError("helper_down", 503, HELPER_DOWN))
        }
      }),
    )
  })
}

/** Deviation from the brief: throws MidError on `{ok:false}` instead of returning it, so routes need no branching. */
export async function callHelper(req: HelperRequest): Promise<{ ok: true }> {
  const res = await roundTrip(req, env.helperSocket)
  if (res.ok) return res
  switch (res.code) {
    case "quota_full":
    case "invalid_name":
    case "not_found":
      throw new MidError(res.code)
    case "invalid_request":
      throw new MidError(res.code, 400, res.message)
    default:
      throw new MidError(res.code, 500, res.message)
  }
}
