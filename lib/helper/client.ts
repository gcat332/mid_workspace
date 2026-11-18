import net from "node:net"
import { env } from "@/lib/env"
import { MidError } from "@/lib/mids/names"
import { CLIENT_TIMEOUT_MS, HELPER_ERROR_CODES, type HelperRequest, type HelperResponse } from "./protocol"

const HELPER_DOWN = "ตัวช่วยระบบ (midhub-helper) ไม่ทำงาน กรุณาแจ้ง Admin"

function parse(buf: string): HelperResponse | null {
  try {
    const v = JSON.parse(buf) as Record<string, unknown>
    if (v?.ok === true) return { ok: true }
    if (v?.ok === false && typeof v.code === "string" && typeof v.message === "string") return v as HelperResponse
  } catch {}
  return null
}

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
    sock.setTimeout(CLIENT_TIMEOUT_MS, () => settle(() => reject(new MidError("helper_down", 503, HELPER_DOWN))))
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (c: string) => (buf += c))
    sock.on("error", (e: NodeJS.ErrnoException) =>
      settle(() => reject(["ENOENT", "ECONNREFUSED", "EACCES"].includes(e.code ?? "") ? new MidError("helper_down", 503, HELPER_DOWN) : e)),
    )
    sock.on("close", () =>
      settle(() => {
        const res = parse(buf)
        if (res) resolve(res)
        else reject(new MidError("helper_down", 503, HELPER_DOWN, `malformed helper reply: ${buf.slice(0, 200)}`))
      }),
    )
  })
}

/** Deviation from the brief: throws MidError on `{ok:false}` instead of returning it, so routes need no branching. */
export async function callHelper(req: HelperRequest): Promise<{ ok: true }> {
  const res = await roundTrip(req, env.helperSocket)
  if (res.ok) return res
  const code = (HELPER_ERROR_CODES as readonly string[]).includes(res.code) ? res.code : "internal"
  // Known codes use the shared Thai message/status; the raw helper text goes to `detail`.
  throw new MidError(code, undefined, undefined, res.message)
}
