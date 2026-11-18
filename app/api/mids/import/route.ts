import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { MidError } from "@/lib/mids/names"
import { importMid } from "@/lib/mids/registry"

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== "object" || typeof body.name !== "string") throw new MidError("invalid_name")
    return NextResponse.json(await importMid(body.name, user), { status: 201 })
  } catch (e) {
    return handleRouteError(e)
  }
}
