import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, jsonError, readJsonObject } from "@/lib/http/route"
import { isValidCidr, clientIpFrom } from "@/lib/net/ip-allowlist"

const DUP = "มีรายการนี้อยู่แล้ว"

// Admin-only. GET also returns the caller's IP as the gate sees it, so the UI can warn
// before a change that would lock the admin out.
export async function GET(req: Request) {
  try { await requireAdmin() } catch (e) { return handleRouteError(e) }
  const entries = await prisma.ipAllowlist.findMany({ orderBy: { createdAt: "desc" } })
  return NextResponse.json({ entries, myIp: clientIpFrom(req.headers) })
}

export async function POST(req: Request) {
  let me
  try { me = await requireAdmin() } catch (e) { return handleRouteError(e) }
  try {
    const b = (await readJsonObject(req)) ?? {}
    const cidr = typeof b.cidr === "string" ? b.cidr.trim() : ""
    if (!cidr || !isValidCidr(cidr)) {
      return jsonError("invalid_cidr", "รูปแบบ IP หรือ CIDR ไม่ถูกต้อง (เช่น 10.0.0.0/8 หรือ 2001:db8::/32)", 400)
    }
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : ""
    if (await prisma.ipAllowlist.findUnique({ where: { cidr } })) return jsonError("conflict", DUP, 409)
    try {
      const row = await prisma.ipAllowlist.create({ data: { cidr, note } })
      await recordAudit(me, "ip_allowlist.add", undefined, { cidr, note })
      return NextResponse.json(row, { status: 201 })
    } catch (e) {
      // Lost a race with a concurrent insert of the same CIDR (unique constraint).
      if ((e as { code?: string }).code === "P2002") return jsonError("conflict", DUP, 409)
      throw e
    }
  } catch (e) {
    return handleRouteError(e)
  }
}

// DELETE /api/admin/ip-allowlist?id=<id>
export async function DELETE(req: Request) {
  let me
  try { me = await requireAdmin() } catch (e) { return handleRouteError(e) }
  try {
    const id = new URL(req.url).searchParams.get("id")
    if (!id) return jsonError("invalid_request", "ต้องระบุ id ของรายการที่จะลบ", 400)
    const row = await prisma.ipAllowlist.findUnique({ where: { id } })
    if (!row) return jsonError("not_found", "ไม่พบรายการนี้ อาจถูกลบไปแล้ว รีเฟรชหน้าแล้วลองใหม่", 404)
    await prisma.ipAllowlist.deleteMany({ where: { id } })
    await recordAudit(me, "ip_allowlist.remove", undefined, { cidr: row.cidr })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleRouteError(e)
  }
}
