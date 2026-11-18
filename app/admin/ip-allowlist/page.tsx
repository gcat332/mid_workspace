import { adminPageUser } from "@/lib/auth/page"
import { AdminNav } from "@/components/AdminNav"
import { IpAllowlistManager } from "@/components/IpAllowlistManager"

export default async function AdminIpAllowlistPage() {
  await adminPageUser()
  return (
    <main className="mx-auto max-w-3xl p-6">
      <AdminNav />
      <IpAllowlistManager />
    </main>
  )
}
