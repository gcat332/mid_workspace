import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { retryJob } from "@/lib/jobs/engine"
import { handleRouteError } from "@/lib/http/route"

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const job = await retryJob(user, id)
    await recordAudit(user, "job.retry", job.midName, { jobId: id, kind: job.kind })
    return NextResponse.json({ jobId: job.id }, { status: 202 })
  } catch (e) {
    return handleRouteError(e)
  }
}
