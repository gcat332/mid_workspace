import { NextResponse } from "next/server"
import { requireUser, responseOrRethrow } from "@/lib/auth/helpers"
import { env } from "@/lib/env"
import { readHostMemory, readSlotUsage } from "@/lib/mids/status"

export async function GET() {
  try {
    await requireUser()
  } catch (e) {
    return responseOrRethrow(e)
  }
  const [mem, slots] = await Promise.all([readHostMemory(), readSlotUsage()])
  return NextResponse.json({ ...mem, running: slots.running, quotaUsed: slots.quotaUsed, maxRunning: env.maxRunning })
}
