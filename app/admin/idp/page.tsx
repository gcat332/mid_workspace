import { adminPageUser } from "@/lib/auth/page"
import { IdpConfigManager } from "@/components/IdpConfigManager"

export default async function AdminIdpPage() {
  await adminPageUser()
  return <IdpConfigManager />
}
