import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import { AdminNav } from "@/components/AdminNav"
import { IpAllowlistManager } from "@/components/IpAllowlistManager"

export default async function AdminIpAllowlistPage() {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  if (user.role !== "admin") redirect("/")
  return (
    <main className="mx-auto max-w-3xl p-6">
      <AdminNav />
      <IpAllowlistManager />
    </main>
  )
}
