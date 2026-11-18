import fs from "node:fs"
import { Readable } from "node:stream"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { downloadInfo } from "@/lib/mids/files"

type Ctx = { params: Promise<{ name: string }> }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name } = await ctx.params
    const info = await downloadInfo(name, new URL(req.url).searchParams.get("path") ?? "")
    const stream = Readable.toWeb(fs.createReadStream(info.path)) as ReadableStream
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(info.filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (e) {
    return handleRouteError(e)
  }
}
