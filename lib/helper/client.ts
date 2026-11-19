import net from "node:net"
import { env } from "@/lib/env"
import { MidError, quotaFullMessage } from "@/lib/mids/names"
import { CLIENT_TIMEOUT_MS, HELPER_ERROR_CODES, type HelperRequest, type HelperResponse } from "./protocol"

/** Next step for whoever can reach the server (shown behind the details toggle). */
const HELPER_HINT = "ตรวจด้วย: systemctl status bsm-midhub-helper (และ journalctl -u bsm-midhub-helper -n 50)"
const helperDown = (extra?: string) => new MidError("helper_down", undefined, undefined, extra ? `${HELPER_HINT}\n${extra}` : HELPER_HINT)

/** systemctl's wording when a unit hit StartLimitBurst (old: "repeated too quickly", new: "attempted too often"). */
const START_LIMIT_RE = /start-limit-hit|attempted too often|repeated too quickly/i
const START_LIMIT_MESSAGE =
  "MID นี้ล้มแล้วเริ่มใหม่เองซ้ำหลายครั้งเกินกำหนด (crash loop) systemd จึงหยุดเริ่มให้ ดูสาเหตุในแท็บ Log แก้ไขแล้วกด Start อีกครั้ง"

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
    sock.setTimeout(CLIENT_TIMEOUT_MS, () => settle(() => reject(helperDown("timeout"))))
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (c: string) => (buf += c))
    sock.on("error", (e: NodeJS.ErrnoException) =>
      settle(() => reject(["ENOENT", "ECONNREFUSED", "EACCES"].includes(e.code ?? "") ? helperDown(e.code) : e)),
    )
    sock.on("close", () =>
      settle(() => {
        const res = parse(buf)
        if (res) resolve(res)
        else reject(helperDown(`malformed helper reply: ${buf.slice(0, 200)}`))
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
  const thai = code === "quota_full" ? quotaFullMessage(env.maxRunning)
    : code === "systemctl_failed" && START_LIMIT_RE.test(res.message) ? START_LIMIT_MESSAGE
    : undefined
  throw new MidError(code, undefined, thai, res.message)
}
