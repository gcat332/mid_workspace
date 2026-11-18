import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import type { SessionPayload } from "@/lib/auth/jwt"

/** For admin pages: signed out -> /login; a member -> dashboard with a visible "admins only" notice. */
export async function adminPageUser(): Promise<SessionPayload> {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  if (user.role !== "admin") redirect("/?notice=forbidden")
  return user
}
