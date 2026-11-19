import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, readJsonObject } from "@/lib/http/route"
import { deleteInstance, updateInstance } from "@/lib/instances/service"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin()
    const { id } = await params
    const b = (await readJsonObject(req)) ?? {}
    const patch: Parameters<typeof updateInstance>[2] = {}
    if (b.label !== undefined) patch.label = typeof b.label === "string" ? b.label : ""
    if (b.midUser !== undefined) patch.midUser = typeof b.midUser === "string" ? b.midUser : ""
    if (b.password !== undefined) patch.password = typeof b.password === "string" ? b.password : ""
    if (b.buildstamp !== undefined) patch.buildstamp = typeof b.buildstamp === "string" && b.buildstamp ? b.buildstamp : null
    const inst = await updateInstance(me, id, patch)
    await recordAudit(me, "instance.update", undefined, { url: inst.url, label: inst.label })
    return NextResponse.json(inst)
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin()
    const { id } = await params
    const inst = await deleteInstance(me, id)
    await recordAudit(me, "instance.delete", undefined, { url: inst.url, label: inst.label })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleRouteError(e)
  }
}

// The corporate F5 WAF in front of the domain rejects every PATCH (its "Request Rejected" page, status 200), so
// the browser sends POST; PATCH stays for API clients that are not behind it.
export const POST = PATCH
