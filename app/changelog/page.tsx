import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import { AppChrome } from "@/components/AppChrome"
import { ChangelogView } from "@/components/ChangelogView"

// MidHub's own CHANGELOG.md, reached via the footer version link.
export const dynamic = "force-dynamic"

export default async function ChangelogPage() {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  return (
    <AppChrome user={{ email: user.email, role: user.role }}>
      <ChangelogView file="CHANGELOG.md" title="Changelog" />
    </AppChrome>
  )
}
