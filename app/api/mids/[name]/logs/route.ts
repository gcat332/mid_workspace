import { requireUser } from "@/lib/auth/helpers"
import { downloadResponse } from "@/lib/http/download"
import { handleRouteError } from "@/lib/http/route"
import { LOG_FILES } from "@/lib/mids/layout"
import { isLogKey, openDownload, openLog } from "@/lib/mids/files"
import { tailFile } from "@/lib/mids/log-tail"
import { MidError } from "@/lib/mids/names"
import { getMid } from "@/lib/mids/registry"

type Ctx = { params: Promise<{ name: string }> }

export const dynamic = "force-dynamic"
const MAX_TAILS = 20
const WINDOW_BYTES = 256 * 1024
const POLL_MS = 1000
const PING_MS = 15_000
let active = 0

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name } = await ctx.params
    await getMid(name) // unknown -> 404
    const sp = new URL(req.url).searchParams
    const key = sp.get("file") ?? "main"
    if (!isLogKey(key)) throw new MidError("invalid_request")
    if (sp.get("download") === "1") return await downloadResponse(await openDownload(name, LOG_FILES[key]))
    if (active >= MAX_TAILS) throw new MidError("busy_tails", 429, "มีคนเปิดดู log สดเต็มจำนวนแล้ว รอสักครู่แล้วลองใหม่")
    const open = await openLog(name, key)
    active++
    const ac = new AbortController()
    const stop = () => ac.abort()
    if (req.signal.aborted) stop()
    req.signal.addEventListener("abort", stop, { once: true })
    const enc = new TextEncoder()
    let ping: ReturnType<typeof setInterval> | undefined
    let released = false
    const release = () => {
      if (released) return
      released = true
      active--
      clearInterval(ping)
      req.signal.removeEventListener("abort", stop)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (s: string) => { try { controller.enqueue(enc.encode(s)) } catch { /* closed */ } }
        ping = setInterval(() => send(": ping\n\n"), PING_MS)
        send(": ok\n\n")
        void (async () => {
          try {
            for await (const lines of tailFile(open, {
              fromBytesBack: WINDOW_BYTES, pollMs: POLL_MS, signal: ac.signal,
              onStatus: (s) => send(`event: status\ndata: ${JSON.stringify({ state: s })}\n\n`),
            })) send(`data: ${JSON.stringify({ lines })}\n\n`)
          } catch (e) {
            const me = e instanceof MidError ? e : null
            send(`event: error\ndata: ${JSON.stringify({ code: me?.code ?? "internal", message: me?.message ?? "อ่าน log ไม่สำเร็จ ลองใหม่อีกครั้ง" })}\n\n`)
          } finally {
            release()
            try { controller.close() } catch { /* already closed */ }
          }
        })()
      },
      cancel() { ac.abort(); release() },
    })
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    })
  } catch (e) {
    return handleRouteError(e)
  }
}
