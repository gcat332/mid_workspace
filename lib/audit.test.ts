import { expect, it, vi } from "vitest"

const create = vi.hoisted(() => vi.fn())
vi.mock("@/lib/db/client", () => ({ prisma: { auditLog: { create } } }))
import { recordAudit } from "./audit"

const user = { userId: "u1", email: "a@x.com", role: "member" as const, authAt: 0 }

it("stores the entry", async () => {
  create.mockResolvedValueOnce({})
  await recordAudit(user, "mid.import", "m1", { a: 1 })
  expect(create).toHaveBeenCalledWith({
    data: { userId: "u1", email: "a@x.com", action: "mid.import", midName: "m1", detail: '{"a":1}' },
  })
})

it("never throws into the caller", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  create.mockRejectedValueOnce(new Error("db down"))
  await expect(recordAudit(user, "x")).resolves.toBeUndefined()
  expect(log).toHaveBeenCalled()
  log.mockRestore()
})
