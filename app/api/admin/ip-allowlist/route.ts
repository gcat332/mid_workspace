import { NextResponse } from "next/server"
import { requireAdmin, responseOrRethrow } from "@/lib/auth/helpers"
import { prisma } from "@/lib/db/client"
import { isValidCidr, clientIpFrom } from "@/lib/net/ip-allowlist"

// Admin-only. GET also returns the caller's IP as the gate sees it, so the UI can warn
// before a change that would lock the admin out.
export async function GET(req: Request) {
  try { await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const entries = await prisma.ipAllowlist.findMany({ orderBy: { createdAt: "desc" } })
  return NextResponse.json({ entries, myIp: clientIpFrom(req.headers) })
}

export async function POST(req: Request) {
  try { await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const b = (await req.json().catch(() => ({}))) as { cidr?: unknown; note?: unknown }
  const cidr = typeof b.cidr === "string" ? b.cidr.trim() : ""
  if (!cidr || !isValidCidr(cidr)) {
    return NextResponse.json({ error: "รูปแบบ IP หรือ CIDR ไม่ถูกต้อง (เช่น 10.0.0.0/8 หรือ 2001:db8::/32)" }, { status: 400 })
  }
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : ""
  if (await prisma.ipAllowlist.findUnique({ where: { cidr } })) {
    return NextResponse.json({ error: "มีรายการนี้อยู่แล้ว" }, { status: 409 })
  }
  try {
    const row = await prisma.ipAllowlist.create({ data: { cidr, note } })
    return NextResponse.json(row, { status: 201 })
  } catch (e) {
    // Lost a race with a concurrent insert of the same CIDR (unique constraint).
    if ((e as { code?: string }).code === "P2002") return NextResponse.json({ error: "มีรายการนี้อยู่แล้ว" }, { status: 409 })
    throw e
  }
}

// DELETE /api/admin/ip-allowlist?id=<id>
export async function DELETE(req: Request) {
  try { await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const id = new URL(req.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "ต้องระบุ id" }, { status: 400 })
  await prisma.ipAllowlist.deleteMany({ where: { id } })
  return NextResponse.json({ ok: true })
}
