import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import { cancelJob } from "@/lib/jobs/engine"
import { handleRouteError } from "@/lib/http/route"

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const target = await prisma.job.findUnique({ where: { id }, select: { kind: true } })
    const job = await cancelJob(user, id)
    // cancelJob returns the cleanup job when cancelling a failed install/clone, otherwise the cancelled job itself.
    await recordAudit(user, "job.cancel", job.midName, {
      cancelledJobId: id,
      cancelledKind: target?.kind ?? job.kind,
      ...(job.id !== id ? { cleanupJobId: job.id } : {}),
    })
    return NextResponse.json({ jobId: job.id }, { status: 202 })
  } catch (e) {
    return handleRouteError(e)
  }
}
