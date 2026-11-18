import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { listPackages } from "@/lib/mids/packages"

export async function GET() {
  try {
    await requireUser()
    return NextResponse.json(await listPackages())
  } catch (e) {
    return handleRouteError(e)
  }
}
