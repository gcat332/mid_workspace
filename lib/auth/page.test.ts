import { beforeEach, expect, it, vi } from "vitest"

const getSessionUser = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/helpers", () => ({ getSessionUser }))
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { to }) } }))

beforeEach(() => getSessionUser.mockReset())

it("a member opening an admin page lands on the dashboard with ?notice=forbidden (Q-M8)", async () => {
  const { adminPageUser } = await import("./page")
  getSessionUser.mockResolvedValue({ userId: "u2", email: "m@x.com", role: "member" })
  await expect(adminPageUser()).rejects.toMatchObject({ to: "/?notice=forbidden" })
  getSessionUser.mockResolvedValue(null)
  await expect(adminPageUser()).rejects.toMatchObject({ to: "/login" })
  getSessionUser.mockResolvedValue({ userId: "u1", email: "a@x.com", role: "admin" })
  await expect(adminPageUser()).resolves.toMatchObject({ userId: "u1" })
})
