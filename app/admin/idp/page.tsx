import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import { AdminNav } from "@/components/AdminNav"
import { IdpConfigManager } from "@/components/IdpConfigManager"

export default async function AdminIdpPage() {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  if (user.role !== "admin") redirect("/")
  return (
    <main className="mx-auto max-w-3xl p-6">
      <AdminNav />
      <IdpConfigManager />
    </main>
  )
}
