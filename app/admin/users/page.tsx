import { adminPageUser } from "@/lib/auth/page"
import { AdminNav } from "@/components/AdminNav"
import { UsersManager } from "@/components/UsersManager"

export default async function AdminUsersPage() {
  const user = await adminPageUser()
  return (
    <main className="mx-auto max-w-3xl p-6">
      <AdminNav />
      <UsersManager myId={user.userId} />
    </main>
  )
}
