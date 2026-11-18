import { adminPageUser } from "@/lib/auth/page"
import { AdminNav } from "@/components/AdminNav"
import { IdpConfigManager } from "@/components/IdpConfigManager"

export default async function AdminIdpPage() {
  await adminPageUser()
  return (
    <main className="mx-auto max-w-3xl p-6">
      <AdminNav />
      <IdpConfigManager />
    </main>
  )
}
