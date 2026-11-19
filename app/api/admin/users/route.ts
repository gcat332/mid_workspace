import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { handleRouteError } from "@/lib/http/route"
import { USER_SELECT } from "@/lib/auth/user-admin"

// Users are created on their first sign-in through AgentHub (admins only); there is no create here.
export async function GET() {
  try {
    await requireAdmin()
    const users = await prisma.user.findMany({ select: USER_SELECT, orderBy: { createdAt: "asc" } })
    return NextResponse.json(users)
  } catch (e) {
    return handleRouteError(e)
  }
}
