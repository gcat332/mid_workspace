import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, readJsonObject } from "@/lib/http/route"
import { createInstance, listInstances } from "@/lib/instances/service"

const str = (v: unknown): string => (typeof v === "string" ? v : "")

export async function GET() {
  try {
    await requireUser()
    return NextResponse.json(await listInstances())
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireUser()
    const b = (await readJsonObject(req)) ?? {}
    const inst = await createInstance(me, { label: str(b.label), url: str(b.url), midUser: str(b.midUser), password: str(b.password) })
    await recordAudit(me, "instance.create", undefined, { url: inst.url, label: inst.label })
    return NextResponse.json(inst, { status: 201 })
  } catch (e) {
    return handleRouteError(e)
  }
}
