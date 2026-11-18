import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { getBackup, loadConfigFiles, rollback } from "@/lib/mids/config-service"

type Ctx = { params: Promise<{ name: string; id: string }> }

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name, id } = await ctx.params
    return NextResponse.json(await getBackup(name, id))
  } catch (e) {
    return handleRouteError(e)
  }
}

/** Rollback: restores this backup (the content it replaces is backed up first). */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const user = await requireUser()
    const { name, id } = await ctx.params
    await rollback(name, id, user)
    return NextResponse.json({ ok: true, ...(await loadConfigFiles(name)) })
  } catch (e) {
    return handleRouteError(e)
  }
}
