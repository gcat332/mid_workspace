import { agentRoute } from "@/lib/agent/http"
import { usableMidParam } from "@/lib/agent/checks"
import { isLogKey, openLog } from "@/lib/mids/files"
import { readLastLines } from "@/lib/mids/log-lines"
import { MidError } from "@/lib/mids/names"

type Ctx = { params: Promise<{ name: string }> }

export const dynamic = "force-dynamic"
const DEFAULT_LINES = 200
const MAX_LINES = 2000

/** `lines` default 200, clamped to [1, 2000]; anything non-numeric is the default. */
function lineCount(raw: string | null): number {
  const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_LINES
  return Math.min(MAX_LINES, Math.max(1, Math.trunc(n)))
}

/** GET ?file=main|wrapper&lines=200 -> { lines } (spec 5.3). Read-only: not audited. A missing log is no lines. */
export const GET = agentRoute<Ctx>(async (req, caller, ctx) => {
  const { name } = await usableMidParam(caller, ctx.params)
  const sp = new URL(req.url).searchParams
  const key = sp.get("file") ?? "main"
  if (!isLogKey(key)) throw new MidError("invalid_request", 400, "file ต้องเป็น main หรือ wrapper เท่านั้น แก้พารามิเตอร์แล้วลองใหม่")
  const open = await openLog(name, key)
  try {
    return Response.json({ lines: await readLastLines(open, lineCount(sp.get("lines"))) })
  } catch (e) {
    if (e instanceof MidError && e.code === "not_found") return Response.json({ lines: [] })
    throw e
  }
})
