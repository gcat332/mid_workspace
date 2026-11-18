import { adminPageUser } from "@/lib/auth/page"
import { AdminNav } from "@/components/AdminNav"
import { AuditLog } from "@/components/AuditLog"

export default async function AdminAuditPage() {
  await adminPageUser()
  return (
    <main className="mx-auto max-w-5xl p-6">
      <AdminNav />
      <AuditLog />
    </main>
  )
}
