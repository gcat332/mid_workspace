import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, readJsonObject } from "@/lib/http/route"
import { normalizeInstanceUrl, testConnection } from "@/lib/instances/service"

const str = (v: unknown): string => (typeof v === "string" ? v : "")

// Tests credentials without saving anything.
export async function POST(req: Request) {
  try {
    const me = await requireUser()
    const b = (await readJsonObject(req)) ?? {}
    const url = normalizeInstanceUrl(str(b.url))
    const r = await testConnection({ url, midUser: str(b.midUser), password: str(b.password) })
    await recordAudit(me, "instance.test", undefined, { url, label: str(b.label) })
    return NextResponse.json(r)
  } catch (e) {
    return handleRouteError(e)
  }
}
