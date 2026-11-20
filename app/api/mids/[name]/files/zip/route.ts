import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { contentDisposition } from "@/lib/http/download"
import { handleRouteError } from "@/lib/http/route"
import { MidError } from "@/lib/mids/names"
import { planZip, zipPlanStream } from "@/lib/mids/zip"

type Ctx = { params: Promise<{ name: string }> }

// GET ?dir=&name=a&name=b[&check=1] -> application/zip stream, or { files, bytes } with check=1 (no slot, no bytes)
const MAX_ZIP_STREAMS = 2
const BUSY_MSG = "มีการดาวน์โหลด .zip อยู่ 2 รายการแล้ว รอให้เสร็จแล้วลองใหม่"
const slots = globalThis as unknown as { __midhubZipStreams?: number }
const active = () => slots.__midhubZipStreams ?? 0
const assertFree = () => { if (active() >= MAX_ZIP_STREAMS) throw new MidError("busy", 429, BUSY_MSG) }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name } = await ctx.params
    const url = new URL(req.url)
    assertFree()
    const plan = await planZip(name, url.searchParams.get("dir") ?? "", url.searchParams.getAll("name"))
    if (url.searchParams.get("check") === "1") return NextResponse.json({ files: plan.files, bytes: plan.bytes })

    // The slot is taken lazily on the first pull and released exactly once (done, error or cancel), so a Response
    // that is never read (HEAD, aborted request) can't leak it.
    let held = false
    const release = () => { if (held) { held = false; slots.__midhubZipStreams = active() - 1 } }
    const reader = zipPlanStream(name, plan).getReader()
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (!held) {
              assertFree()
              held = true
              slots.__midhubZipStreams = active() + 1
            }
            const r = await reader.read()
            if (r.done) { release(); controller.close() } else controller.enqueue(r.value)
          } catch (e) {
            release()
            await reader.cancel().catch(() => {})
            controller.error(e)
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason) } finally { release() }
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(plan.filename),
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (e) {
    return handleRouteError(e)
  }
}

/** Next maps HEAD to GET and never reads the body; answer without planning or taking a slot. */
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: "GET" } })
}
