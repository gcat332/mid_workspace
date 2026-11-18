import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import { Dashboard } from "@/components/Dashboard"

export const dynamic = "force-dynamic"

export default async function Home() {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  return (
    <Suspense>
      <Dashboard email={user.email} userId={user.userId} isAdmin={user.role === "admin"} />
    </Suspense>
  )
}
