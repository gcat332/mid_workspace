import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { hashPassword } from "@/lib/auth/session"

/**
 * Ensures ADMIN_EMAIL exists as an admin. Idempotent; never overwrites an existing password.
 * Also clears a login lock on that account, so restarting the service is the documented break-glass
 * when the only admin got locked out.
 */
export async function seedAdmin(): Promise<void> {
  const email = env.adminEmail
  const passwordHash = await hashPassword(env.adminPassword)
  await prisma.user.upsert({
    where: { email },
    update: { role: "admin", lockedAt: null, failedLoginCount: 0 },
    create: { email, passwordHash, role: "admin" },
  })
}
