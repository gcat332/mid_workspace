import { expect, it, vi } from "vitest"

const upsert = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock("@/lib/db/client", () => ({ prisma: { user: { upsert } } }))
vi.mock("@/lib/env", () => ({ env: { adminEmail: "admin@x.com", adminPassword: "pw-123456" } }))

it("seedAdmin clears a lock on ADMIN_EMAIL at boot (break-glass: restart the service) (I3)", async () => {
  const { seedAdmin } = await import("./seed")
  await seedAdmin()
  const arg = (upsert.mock.calls[0] as unknown as [{ where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }])[0]
  expect(arg.where).toEqual({ email: "admin@x.com" })
  expect(arg.update).toEqual({ role: "admin", lockedAt: null, failedLoginCount: 0 })
  expect(arg.update).not.toHaveProperty("passwordHash") // never overwrites an existing password
  expect(String(arg.create.passwordHash)).toMatch(/^\$2[aby]\$/)
})
