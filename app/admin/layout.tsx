import type { ReactNode } from "react"
import { AdminNav } from "@/components/AdminNav"
import { AppChrome } from "@/components/AppChrome"
import { getSessionUser } from "@/lib/auth/helpers"

export const dynamic = "force-dynamic"

// Shared admin frame (same width as the dashboard). Each page still checks the session itself
// (adminPageUser): layouts are not re-run on client-side navigation between admin pages.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser()
  const body = (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <AdminNav />
      {children}
    </main>
  )
  // No session: the page's own check redirects to /login; render no chrome meanwhile.
  return user ? <AppChrome user={{ email: user.email, role: user.role }}>{body}</AppChrome> : body
}
