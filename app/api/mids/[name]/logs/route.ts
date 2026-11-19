import { cookies } from "next/headers"
import { requireUser, userFromToken } from "@/lib/auth/helpers"
import { SESSION_COOKIE } from "@/lib/auth/jwt"
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
/** Lines of the initial window actually sent; the UI keeps no more than this. */
const INITIAL_LINES = 150
/** The held initial lines go out in frames of at most about this many bytes (150 lines of 16 KiB would otherwise trip the stall check). */
const MAX_FRAME_BYTES = 200 * 1024
const POLL_MS = 1000
const PING_MS = 15_000
const STALL_MS = 10_000
const MAX_QUEUED_BYTES = 1_000_000
/** A long-lived stream re-checks its session this often and closes once it is revoked (lock/delete/reset). */
const REAUTH_MS = 60_000
let active = 0

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const token = (await cookies()).get(SESSION_COOKIE)?.value
    const { name } = await ctx.params
    await getMid(name) // unknown -> 404
    const sp = new URL(req.url).searchParams
    const key = sp.get("file") ?? "main"
    if (!isLogKey(key)) throw new MidError("invalid_request")
    if (sp.get("download") === "1") return await downloadResponse(await openDownload(name, LOG_FILES[key]))
    if (active >= MAX_TAILS) throw new MidError("busy_tails", 429, "มีคนเปิดดู log สดเต็มจำนวนแล้ว รอสักครู่แล้วลองใหม่")
    const open = await openLog(name, key)
    active++
    // First verified open happens before any Response exists, so permanent errors (FIFO, path_outside, EACCES)
    // are proper 4xx. A missing file is not an error: the stream reports it as a status and keeps waiting.
    let pre: Awaited<ReturnType<typeof open>> | null = null
    try {
      pre = await open()
    } catch (e) {
      if (!(e instanceof MidError && e.code === "not_found")) { active--; throw e }
    }
    const openOnce: typeof open = async () => {
      if (pre) { const p = pre; pre = null; return p }
      return open()
    }
    const ac = new AbortController()
    const stop = () => ac.abort()
    if (req.signal.aborted) stop()
    req.signal.addEventListener("abort", stop, { once: true })
    const enc = new TextEncoder()
    let ping: ReturnType<typeof setInterval> | undefined
    let watch: ReturnType<typeof setInterval> | undefined
    let reauth: ReturnType<typeof setInterval> | undefined
    let released = false
    let stalledSince = 0
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    const release = () => {
      if (released) return
      released = true
      active--
      clearInterval(ping); clearInterval(watch); clearInterval(reauth)
      req.signal.removeEventListener("abort", stop)
      void pre?.h.close().catch(() => {}) // never handed to the tail
    }
    /** Client not reading: drop it (it reconnects) rather than queue without bound. */
    const checkStall = () => {
      const ds = controllerRef?.desiredSize
      if (ds == null) return
      if (ds < -MAX_QUEUED_BYTES) { ac.abort(); return }
      if (ds > 0) { stalledSince = 0; return }
      stalledSince ||= Date.now()
      if (Date.now() - stalledSince > STALL_MS) ac.abort()
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller
        const send = (s: string) => { try { controller.enqueue(enc.encode(s)); checkStall() } catch { /* closed */ } }
        ping = setInterval(() => { if ((controller.desiredSize ?? 0) >= 0) send(": ping\n\n") }, PING_MS)
        watch = setInterval(checkStall, 1000)
        reauth = setInterval(() => {
          void userFromToken(token).then(
            (u) => { if (!u) ac.abort() },
            () => {}, // DB hiccup: keep streaming, try again next round
          )
        }, REAUTH_MS)
        send(": ok\n\n")
        void (async () => {
          try {
            // The initial window arrives in several batches: hold them back and send only its last INITIAL_LINES.
            let initial: string[] | null = []
            const sendLines = (lines: string[]) => send(`data: ${JSON.stringify({ lines })}\n\n`)
            for await (const lines of tailFile(openOnce, {
              fromBytesBack: WINDOW_BYTES, pollMs: POLL_MS, signal: ac.signal,
              onStatus: (s) => send(`event: status\ndata: ${JSON.stringify({ state: s })}\n\n`),
              onCaughtUp: async () => {
                const held = initial
                initial = null
                if (!held?.length) return
                let chunk: string[] = []
                let bytes = 0
                for (const l of held.slice(-INITIAL_LINES)) {
                  const b = Buffer.byteLength(l)
                  if (chunk.length && bytes + b > MAX_FRAME_BYTES) {
                    sendLines(chunk); chunk = []; bytes = 0
                    // Let the client drain before the next chunk, or the whole window would sit in the queue at once.
                    while (!ac.signal.aborted && (controller.desiredSize ?? 1) <= 0) await new Promise((r) => setTimeout(r, 20))
                    stalledSince = 0 // the client drained: a slow-but-healthy link must not be cut 10 s after the first frame
                  }
                  chunk.push(l); bytes += b
                }
                sendLines(chunk)
              },
            })) {
              if (initial) initial = initial.concat(lines).slice(-INITIAL_LINES)
              else sendLines(lines)
            }
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
    }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }))
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    })
  } catch (e) {
    return handleRouteError(e)
  }
}
