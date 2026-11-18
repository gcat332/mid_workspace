import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { handleRouteError } from "@/lib/http/route"
import { MID_NAME_RE } from "@/lib/mids/name-regex"
import { NAME_TAKEN } from "@/lib/jobs/lifecycle"
import { MidError } from "@/lib/mids/names"

export async function GET(req: Request) {
  try {
    await requireUser()
    const name = new URL(req.url).searchParams.get("name") ?? ""
    if (!MID_NAME_RE.test(name)) return NextResponse.json({ valid: false, available: false, message: new MidError("invalid_name").message })
    const row = await prisma.midServer.findUnique({ where: { name } })
    if (row && row.state !== "removed") return NextResponse.json({ valid: true, available: false, message: NAME_TAKEN })
    return NextResponse.json({ valid: true, available: true })
  } catch (e) {
    return handleRouteError(e)
  }
}
