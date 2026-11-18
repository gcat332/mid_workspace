import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/auth/helpers"
import { LoginForm } from "@/components/LoginForm"

export const dynamic = "force-dynamic"

// The proxy lets /login through on any cookie; only a session the DB still accepts skips the form.
// A revoked one (locked, deleted, password reset) gets the form instead of bouncing back and forth.
export default async function LoginPage() {
  if (await getSessionUser()) redirect("/")
  return <LoginForm />
}
