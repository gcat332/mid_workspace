import { NextResponse } from "next/server"
import { getSessionUser, UNAUTHORIZED_MESSAGE } from "@/lib/auth/helpers"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ code: "unauthorized", message: UNAUTHORIZED_MESSAGE }, { status: 401 })
  return NextResponse.json({ email: user.email, role: user.role })
}
