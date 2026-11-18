import { adminPageUser } from "@/lib/auth/page"
import { InstancesManager } from "@/components/InstancesManager"

export default async function AdminInstancesPage() {
  await adminPageUser()
  return <InstancesManager />
}
