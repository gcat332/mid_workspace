import { requireAdmin, responseOrRethrow } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { prisma } from "@/lib/db/client"
import type { Prisma, AuditLog } from "@prisma/client"

type Row = AuditLog

const PAGE_SIZE = 50
const MAX_FILTER = 100
const BATCH = 200
const MAX_BATCHES = 50 // scan budget per request: 10k rows

const bad = (message: string) => Response.json({ code: "invalid_request", message }, { status: 400 })

export function encodeCursor(row: { at: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ at: row.at.getTime(), id: row.id })).toString("base64url")
}

function decodeCursor(raw: string): { at: Date; id: string } | null {
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { at?: unknown; id?: unknown }
    if (typeof j.at !== "number" || !Number.isFinite(j.at) || typeof j.id !== "string" || !j.id) return null
    const at = new Date(j.at)
    return Number.isNaN(at.getTime()) ? null : { at, id: j.id }
  } catch {
    return null
  }
}

export async function GET(req: Request) {
  try { await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  try {
    const q = new URL(req.url).searchParams
    const mid = (q.get("mid") ?? "").trim()
    const user = (q.get("user") ?? "").trim().toLowerCase()
    const cursorRaw = (q.get("cursor") ?? "").trim()
    if (mid.length > MAX_FILTER || user.length > MAX_FILTER) return bad(`ตัวกรองยาวเกิน ${MAX_FILTER} ตัวอักษร`)

    let cursor = cursorRaw ? decodeCursor(cursorRaw) : null
    if (cursorRaw && !cursor) return bad("cursor ไม่ถูกต้อง ลองโหลดหน้าแรกใหม่")

    // The user filter is applied here rather than as Prisma `contains`: that compiles to an unescaped
    // LIKE, so `_` / `%` typed by the admin would act as wildcards. Scanning in batches keeps it literal.
    const matches = (r: Row) => !user || r.email.toLowerCase().includes(user)
    const take = user ? BATCH : PAGE_SIZE + 1
    const items: Row[] = []
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const and: Prisma.AuditLogWhereInput[] = []
      if (mid) and.push({ midName: mid })
      if (cursor) and.push({ OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }] })
      const rows = await prisma.auditLog.findMany({
        where: and.length ? { AND: and } : undefined,
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take,
      })
      for (const r of rows) {
        if (!matches(r)) continue
        if (items.length === PAGE_SIZE) return Response.json({ items, nextCursor: encodeCursor(items[PAGE_SIZE - 1]) })
        items.push(r)
      }
      if (rows.length < take) return Response.json({ items, nextCursor: null })
      cursor = rows[rows.length - 1]
    }
    // Scan budget spent with a short page: hand back what we have and let the client continue from where we stopped.
    return Response.json({ items, nextCursor: cursor ? encodeCursor(cursor) : null })
  } catch (e) {
    return handleRouteError(e)
  }
}
