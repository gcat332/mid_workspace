import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { env } from "@/lib/env"
import { handleRouteError } from "@/lib/http/route"
import { readHostMemory, readSlotUsage } from "@/lib/mids/status"

export async function GET() {
  try {
    await requireUser()
    const [mem, slots] = await Promise.all([readHostMemory(), readSlotUsage()])
    return NextResponse.json({ ...mem, running: slots.running, quotaUsed: slots.quotaUsed, maxRunning: env.maxRunning })
  } catch (e) {
    return handleRouteError(e)
  }
}
