import { adminPageUser } from "@/lib/auth/page"
import { AuditLog } from "@/components/AuditLog"

export default async function AdminAuditPage() {
  await adminPageUser()
  return <AuditLog />
}
