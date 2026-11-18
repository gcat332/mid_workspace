import { beforeEach, expect, it, vi } from "vitest"

let signedIn = true
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Response("{}", { status: 401 })
    return { userId: "u1", email: "a@x.com", role: "member" }
  }),
}))
const listPackages = vi.fn(async () => [{ buildstamp: "b1", bytes: 5 }])
vi.mock("@/lib/mids/packages", () => ({ listPackages }))

beforeEach(() => {
  signedIn = true
  listPackages.mockClear()
})

it("401 when signed out, without listing", async () => {
  signedIn = false
  const { GET } = await import("./route")
  expect((await GET()).status).toBe(401)
  expect(listPackages).not.toHaveBeenCalled()
})

it("returns the cached packages for a member", async () => {
  const { GET } = await import("./route")
  const res = await GET()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ buildstamp: "b1", bytes: 5 }])
})
