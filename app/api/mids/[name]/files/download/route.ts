import { Readable } from "node:stream"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { openDownload } from "@/lib/mids/files"

type Ctx = { params: Promise<{ name: string }> }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name } = await ctx.params
    // All checks and the open happen here, before any Response exists; the stream reads the verified fd only.
    const { handle, size, filename } = await openDownload(name, new URL(req.url).searchParams.get("path") ?? "")
    let body: ReadableStream | null = null
    if (size === 0) await handle.close()
    else body = Readable.toWeb(handle.createReadStream({ start: 0, end: size - 1, autoClose: true })) as ReadableStream
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (e) {
    return handleRouteError(e)
  }
}
