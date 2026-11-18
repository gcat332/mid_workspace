import { adminPageUser } from "@/lib/auth/page"
import { UsersManager } from "@/components/UsersManager"

export default async function AdminUsersPage() {
  const user = await adminPageUser()
  return <UsersManager myId={user.userId} />
}
