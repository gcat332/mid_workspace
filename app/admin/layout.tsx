import type { ReactNode } from "react"
import { AdminNav } from "@/components/AdminNav"

// Shared admin frame (same width as the dashboard). Each page still checks the session itself
// (adminPageUser): layouts are not re-run on client-side navigation between admin pages.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <AdminNav />
      {children}
    </main>
  )
}
