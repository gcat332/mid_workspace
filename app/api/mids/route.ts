import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { listMids } from "@/lib/mids/registry"

export async function GET() {
  try {
    await requireUser()
    return NextResponse.json(await listMids())
  } catch (e) {
    return handleRouteError(e)
  }
}
