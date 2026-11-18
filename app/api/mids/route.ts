import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, readJsonObject } from "@/lib/http/route"
import { parseCreateBody, startInstall } from "@/lib/jobs/lifecycle"
import { MidError } from "@/lib/mids/names"
import { listMids } from "@/lib/mids/registry"

export async function GET() {
  try {
    await requireUser()
    return NextResponse.json(await listMids())
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJsonObject(req)
    if (!body) throw new MidError("invalid_request")
    const input = parseCreateBody(body)
    const { job, kind } = await startInstall(user, input)
    await recordAudit(user, "job.create", input.name, { kind, snName: input.snName, ...(input.cloneFrom ? { cloneFrom: input.cloneFrom } : {}) })
    return NextResponse.json({ jobId: job.id }, { status: 202 })
  } catch (e) {
    return handleRouteError(e)
  }
}
