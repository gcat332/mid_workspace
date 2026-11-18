import { beforeEach, expect, it, vi } from "vitest"

let signedIn = true
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Response("{}", { status: 401 })
    return { userId: "u1", email: "a@x.com", role: "member" }
  }),
}))
const readHostMemory = vi.fn(async () => ({ totalBytes: 8000, availableBytes: 3000 }))
const readSlotUsage = vi.fn(async () => ({ running: 2, quotaUsed: 3 }))
vi.mock("@/lib/mids/status", () => ({ readHostMemory, readSlotUsage }))
const disk = { freeBytes: 5e9, totalBytes: 9e9, usage: { mids: 1, packages: 2, archive: 3 } }
vi.mock("@/lib/mids/packages", () => ({ diskStatus: vi.fn(async () => disk) }))
vi.mock("@/lib/env", () => ({ env: { maxRunning: 4 } }))

beforeEach(() => {
  signedIn = true
  readHostMemory.mockClear()
  readSlotUsage.mockClear()
})

it("401 when signed out, without touching the host", async () => {
  signedIn = false
  const { GET } = await import("./route")
  expect((await GET()).status).toBe(401)
  expect(readHostMemory).not.toHaveBeenCalled()
})

it("returns memory, running, quotaUsed and maxRunning", async () => {
  const { GET } = await import("./route")
  const res = await GET()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ totalBytes: 8000, availableBytes: 3000, running: 2, quotaUsed: 3, maxRunning: 4, disk })
})
