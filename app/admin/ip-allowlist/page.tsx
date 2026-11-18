import { adminPageUser } from "@/lib/auth/page"
import { IpAllowlistManager } from "@/components/IpAllowlistManager"

export default async function AdminIpAllowlistPage() {
  await adminPageUser()
  return <IpAllowlistManager />
}
