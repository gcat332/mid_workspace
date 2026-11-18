import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { listBackups } from "@/lib/mids/config-service"

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  try {
    await requireUser()
    return NextResponse.json({ backups: await listBackups((await ctx.params).name) })
  } catch (e) {
    return handleRouteError(e)
  }
}
