import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import { AdminNav } from "@/components/AdminNav"
import { AuditLog } from "@/components/AuditLog"

export default async function AdminAuditPage() {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  if (user.role !== "admin") redirect("/")
  return (
    <main className="mx-auto max-w-5xl p-6">
      <AdminNav />
      <AuditLog />
    </main>
  )
}
