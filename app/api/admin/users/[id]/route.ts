import { NextResponse } from "next/server"
import { requireAdmin, responseOrRethrow } from "@/lib/auth/helpers"
import { hashPassword } from "@/lib/auth/session"
import { prisma } from "@/lib/db/client"
import { USER_SELECT, PASSWORD_MIN_ERROR } from "@/lib/auth/user-admin"

type Ctx = { params: Promise<{ id: string }> }
const SELF = "ไม่สามารถลดสิทธิ์/ลบบัญชีตัวเองได้"
const LAST_ADMIN = "ต้องมี admin อย่างน้อย 1 คนในระบบ"

const err = (error: string, status: number) => NextResponse.json({ error }, { status })

export async function PATCH(req: Request, { params }: Ctx) {
  let me
  try { me = await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const { id } = await params
  const b = (await req.json().catch(() => ({}))) as { role?: unknown; unlock?: unknown; password?: unknown }
  const data: { role?: string; lockedAt?: null; failedLoginCount?: number; passwordHash?: string } = {}
  if (b.role !== undefined) {
    if (b.role !== "admin" && b.role !== "member") return err("สิทธิ์ต้องเป็น admin หรือ member", 400)
    data.role = b.role
  }
  if (b.unlock === true) { data.lockedAt = null; data.failedLoginCount = 0 }
  if (b.password !== undefined) {
    if (typeof b.password !== "string" || b.password.length < 8) return err(PASSWORD_MIN_ERROR, 400)
    data.passwordHash = await hashPassword(b.password)
  }
  if (Object.keys(data).length === 0) return err("ไม่มีข้อมูลที่ต้องแก้ไข", 400)

  if (data.role === "member" && id === me.userId) return err(SELF, 400)
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (!target) return err("ไม่พบผู้ใช้", 404)
  if (data.role === "member" && target.role === "admin" && (await prisma.user.count({ where: { role: "admin" } })) <= 1) {
    return err(LAST_ADMIN, 400)
  }
  const user = await prisma.user.update({ where: { id }, data, select: USER_SELECT })
  return NextResponse.json(user)
}

export async function DELETE(_req: Request, { params }: Ctx) {
  let me
  try { me = await requireAdmin() } catch (e) { return responseOrRethrow(e) }
  const { id } = await params
  if (id === me.userId) return err(SELF, 400)
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (!target) return err("ไม่พบผู้ใช้", 404)
  if (target.role === "admin" && (await prisma.user.count({ where: { role: "admin" } })) <= 1) {
    return err(LAST_ADMIN, 400)
  }
  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
