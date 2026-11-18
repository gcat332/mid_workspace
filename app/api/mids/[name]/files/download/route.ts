import { requireUser } from "@/lib/auth/helpers"
import { downloadResponse } from "@/lib/http/download"
import { handleRouteError } from "@/lib/http/route"
import { openDownload } from "@/lib/mids/files"

type Ctx = { params: Promise<{ name: string }> }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name } = await ctx.params
    // All checks and the open happen here, before any Response exists; the stream reads the verified fd only.
    return await downloadResponse(await openDownload(name, new URL(req.url).searchParams.get("path") ?? ""))
  } catch (e) {
    return handleRouteError(e)
  }
}
