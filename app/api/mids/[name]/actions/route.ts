import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { callHelper } from "@/lib/helper/client"
import { handleRouteError } from "@/lib/http/route"
import { getMid } from "@/lib/mids/registry"
import { readHostMemory } from "@/lib/mids/status"

const ACTIONS = ["start", "stop", "restart", "fixOwnership"] as const
type Action = (typeof ACTIONS)[number]
/** Audit action names (fixOwnership keeps the dotted snake_case style of the others). */
const AUDIT: Record<Action, string> = { start: "mid.start", stop: "mid.stop", restart: "mid.restart", fixOwnership: "mid.fix_ownership" }

const GIB = 1024 ** 3
const LOW_MEMORY_BYTES = GIB

function invalid(message: string) {
  return NextResponse.json({ code: "invalid_request", message }, { status: 400 })
}

function parseBody(raw: unknown): { action: Action; confirmLowMemory?: boolean } | null {
  if (typeof raw !== "object" || raw === null) return null
  const { action, confirmLowMemory } = raw as Record<string, unknown>
  if (!ACTIONS.includes(action as Action)) return null
  if (confirmLowMemory !== undefined && typeof confirmLowMemory !== "boolean") return null
  return { action: action as Action, confirmLowMemory }
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireUser()
    const body = parseBody(await req.json().catch(() => null))
    if (!body) return invalid("คำสั่งไม่ถูกต้อง ต้องเป็น start, stop, restart หรือ fixOwnership")
    const { action, confirmLowMemory } = body

    const mid = await getMid((await ctx.params).name)

    const state = mid.status.state
    const needsMemory = action === "start" || (action === "restart" && state !== "running" && state !== "starting")
    if (needsMemory && !confirmLowMemory) {
      const { availableBytes } = await readHostMemory()
      if (availableBytes < LOW_MEMORY_BYTES) {
        const gb = (availableBytes / GIB).toFixed(1)
        return NextResponse.json(
          {
            code: "low_memory",
            message: `RAM ว่างเหลือน้อย (${gb} GB) การ start อาจทำให้เครื่องช้าหรือ AgentHub ล่ม — กดยืนยันถ้าต้องการทำต่อ`,
            availableBytes,
          },
          { status: 409 },
        )
      }
    }

    const detail = confirmLowMemory === undefined ? {} : { confirmLowMemory }
    try {
      await callHelper({ op: action, name: mid.name })
    } catch (e) {
      // Failed attempts belong in the trail too (who tried to start what, and why it was refused).
      await recordAudit(user, AUDIT[action], mid.name, { ...detail, ok: false, code: (e as { code?: string }).code ?? "internal" })
      throw e
    }
    await recordAudit(user, AUDIT[action], mid.name, detail)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleRouteError(e)
  }
}
