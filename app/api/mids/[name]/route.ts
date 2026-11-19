import { NextResponse } from "next/server"
import { requireAdmin, requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, readJsonObject } from "@/lib/http/route"
import { startUninstall } from "@/lib/jobs/lifecycle"
import { prisma } from "@/lib/db/client"
import { MidError, validateMidName } from "@/lib/mids/names"
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
    if (!body || body.confirmName !== name) throw new MidError("confirm_mismatch")
    const job = await startUninstall(user, name)
    await recordAudit(user, "mid.uninstall", name, { jobId: job.id })
    return NextResponse.json({ jobId: job.id }, { status: 202 })
  } catch (e) {
    return handleRouteError(e)
  }
}

/** Per-MID AgentHub opt-in (integration spec 5.2). Only `{ agentAccess: boolean }`; any member, any state but removed. */
export async function PATCH(req: Request, ctx: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireUser()
    const name = validateMidName((await ctx.params).name)
    const body = await readJsonObject(req)
    const keys = body ? Object.keys(body) : []
    if (!body || keys.length !== 1 || keys[0] !== "agentAccess" || typeof body.agentAccess !== "boolean") {
      throw new MidError("invalid_request", 400, "ส่งได้เฉพาะ { agentAccess: true | false }")
    }
    const enabled = body.agentAccess
    const r = await prisma.midServer.updateMany({ where: { name, state: { not: "removed" } }, data: { agentAccess: enabled } })
    if (r.count === 0) throw new MidError("not_found")
    await recordAudit(user, "mid.agent_access", name, { enabled })
    return NextResponse.json({ agentAccess: enabled })
  } catch (e) {
    return handleRouteError(e)
  }
}

// The corporate F5 WAF in front of the domain rejects every PATCH (its "Request Rejected" page, status 200), so
// the browser sends POST; PATCH stays for API clients that are not behind it.
export const POST = PATCH
