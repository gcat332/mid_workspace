import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { hashPassword } from "@/lib/auth/session"

/** Ensures ADMIN_EMAIL exists as an admin. Idempotent; never overwrites an existing password. */
export async function seedAdmin(): Promise<void> {
  const email = env.adminEmail
  const passwordHash = await hashPassword(env.adminPassword)
  await prisma.user.upsert({
    where: { email },
    update: { role: "admin" },
    create: { email, passwordHash, role: "admin" },
  })
}
