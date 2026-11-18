import { requireAdmin } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { prisma } from "@/lib/db/client"
import type { Prisma } from "@prisma/client"

const PAGE_SIZE = 50
const MAX_FILTER = 100

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
  try {
    await requireAdmin()
    const q = new URL(req.url).searchParams
    const mid = (q.get("mid") ?? "").trim()
    const user = (q.get("user") ?? "").trim().toLowerCase()
    const cursorRaw = (q.get("cursor") ?? "").trim()
    if (mid.length > MAX_FILTER || user.length > MAX_FILTER) return bad(`ตัวกรองยาวเกิน ${MAX_FILTER} ตัวอักษร`)

    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null
    if (cursorRaw && !cursor) return bad("cursor ไม่ถูกต้อง ลองโหลดหน้าแรกใหม่")

    // Prisma `contains` compiles to an unescaped LIKE (`_` / `%` would act as wildcards), so the user
    // filter is resolved literally in JS over the distinct emails, then applied as an `in` list.
    let emails: string[] | undefined
    if (user) {
      const distinct = await prisma.auditLog.findMany({ distinct: ["email"], select: { email: true } })
      emails = distinct.map((d) => d.email).filter((e) => e.toLowerCase().includes(user))
      if (emails.length === 0) return Response.json({ items: [], nextCursor: null })
    }
    const and: Prisma.AuditLogWhereInput[] = []
    if (mid) and.push({ midName: mid })
    if (emails) and.push({ email: { in: emails } })
    if (cursor) and.push({ OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }] })
    const rows = await prisma.auditLog.findMany({
      where: and.length ? { AND: and } : undefined,
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
    })
    const items = rows.slice(0, PAGE_SIZE)
    return Response.json({ items, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(items[PAGE_SIZE - 1]) : null })
  } catch (e) {
    return handleRouteError(e)
  }
}
