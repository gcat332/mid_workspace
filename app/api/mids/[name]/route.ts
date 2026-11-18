import { NextResponse } from "next/server"
import { requireAdmin, requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, jsonError, readJsonObject } from "@/lib/http/route"
import { startUninstall } from "@/lib/jobs/lifecycle"
import { validateMidName } from "@/lib/mids/names"
import { getMid } from "@/lib/mids/registry"

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  try {
    await requireUser()
    return NextResponse.json(await getMid((await ctx.params).name))
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireAdmin()
    const name = validateMidName((await ctx.params).name)
    const body = await readJsonObject(req)
    if (!body || body.confirmName !== name) return jsonError("confirm_mismatch", "พิมพ์ชื่อ MID ให้ตรงเพื่อยืนยัน", 400)
    const job = await startUninstall(user, name)
    await recordAudit(user, "mid.uninstall", name, { jobId: job.id })
    return NextResponse.json({ jobId: job.id }, { status: 202 })
  } catch (e) {
    return handleRouteError(e)
  }
}
