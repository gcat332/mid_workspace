import fs from "node:fs/promises"
import { requireUser } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { handleRouteError, jsonError } from "@/lib/http/route"
import { journalPath } from "@/lib/jobs/journal"
import { MidError } from "@/lib/mids/names"
import { tailFile } from "@/lib/mids/log-tail"

export const dynamic = "force-dynamic"

export const sse = { maxStreams: 50, statusPollMs: 2000, pingMs: 15000, tailPollMs: 500, drainMs: 1200 }
let active = 0

const TERMINAL = new Set(["succeeded", "failed", "cancelled"])

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser()
    const { id } = await ctx.params
    const job = await prisma.job.findUnique({ where: { id }, select: { id: true } })
    if (!job) throw new MidError("job_not_found")
    if (active >= sse.maxStreams) return jsonError("busy", "มีผู้ติดตามงานมากเกินไป รอสักครู่แล้วลองใหม่", 429)
    const file = journalPath(id)
    active++

    const enc = new TextEncoder()
    const stop = new AbortController()
    let timers: ReturnType<typeof setInterval>[] = []
    let released = false
    const release = () => {
      if (released) return
      released = true
      active--
      stop.abort()
      timers.forEach(clearInterval)
      timers = []
    }
    req.signal.addEventListener("abort", release, { once: true })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (s: string) => {
          if (released) return
          try {
            controller.enqueue(enc.encode(s))
          } catch {
            release()
          }
        }
        const finish = (status: string) => {
          send(`event: done\ndata: ${JSON.stringify({ status })}\n\n`)
          if (!released) {
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }
          release()
        }
        timers.push(setInterval(() => send(": ping\n\n"), sse.pingMs))
        let terminal: string | null = null
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        timers.push(
          setInterval(() => {
            if (terminal || released) return
            prisma.job
              .findUnique({ where: { id }, select: { status: true } })
              .then((j) => {
                if (released || terminal) return
                if (!j) return finish("missing")
                if (TERMINAL.has(j.status)) {
                  terminal = j.status
                  // Give the tail one more poll to flush the last journal lines before ending.
                  drainTimer = setTimeout(() => stop.abort(), sse.drainMs)
                }
              })
              .catch(() => undefined)
          }, sse.statusPollMs),
        )
        void (async () => {
          try {
            const open = async () => {
              const h = await fs.open(file, "r")
              return { h, st: await h.stat() }
            }
            for await (const lines of tailFile(open, { fromBytesBack: Number.MAX_SAFE_INTEGER, pollMs: sse.tailPollMs, signal: stop.signal, maxLineBytes: 64 * 1024 })) {
              send(lines.map((l) => `data: ${l}\n\n`).join(""))
            }
          } catch (e) {
            console.error("[events] tail failed", id, e)
          } finally {
            if (drainTimer) clearTimeout(drainTimer)
          }
          if (terminal) finish(terminal)
          else release()
        })()
      },
      cancel() {
        release()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    })
  } catch (e) {
    return handleRouteError(e)
  }
}
