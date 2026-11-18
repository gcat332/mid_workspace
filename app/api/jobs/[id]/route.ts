import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { handleRouteError } from "@/lib/http/route"
import { kindStageNames } from "@/lib/jobs/engine"
import { MidError } from "@/lib/mids/names"

const SAFE_PARAMS = ["buildstamp", "snName", "heapMb", "logFiles", "cloneFrom"] as const

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser()
    const job = await prisma.job.findUnique({ where: { id: (await ctx.params).id } })
    if (!job) throw new MidError("job_not_found")
    let params: Record<string, unknown> = {}
    try {
      const p = JSON.parse(job.params) as Record<string, unknown>
      for (const k of SAFE_PARAMS) if (p[k] !== undefined) params[k] = p[k]
    } catch {
      params = {}
    }
    return NextResponse.json({
      id: job.id,
      kind: job.kind,
      midName: job.midName,
      stage: job.stage,
      status: job.status,
      error: job.error,
      attempt: job.attempt,
      createdBy: job.createdBy,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      stages: kindStageNames(job.kind),
      params,
    })
  } catch (e) {
    return handleRouteError(e)
  }
}
