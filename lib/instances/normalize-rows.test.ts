import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, unknown>
const db = vi.hoisted(() => ({ inst: [] as Row[], mids: [] as Row[] }))
vi.mock("@/lib/db/client", () => {
  const prisma = {
    instance: {
      findMany: async () => [...db.inst],
      delete: async ({ where }: { where: Row }) => { db.inst = db.inst.filter((r) => r.id !== where.id) },
      update: async ({ where, data }: { where: Row; data: Row }) => { Object.assign(db.inst.find((r) => r.id === where.id)!, data) },
    },
    midServer: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => { db.mids.filter((m) => m.instanceId === where.instanceId).forEach((m) => Object.assign(m, data)) },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  }
  return { prisma }
})
import { normalizeInstanceRows } from "./normalize-rows"

beforeEach(() => { db.inst = []; db.mids = [] })

describe("normalizeInstanceRows", () => {
  it("adds the trailing slash, leaves invalid urls, and is idempotent", async () => {
    db.inst = [
      { id: "a", url: "https://a.service-now.com", midPasswordEnc: null },
      { id: "b", url: "http://b.service-now.com", midPasswordEnc: null },
      { id: "c", url: "https://c.service-now.com/", midPasswordEnc: null },
    ]
    await normalizeInstanceRows()
    expect(db.inst.map((r) => r.url)).toEqual(["https://a.service-now.com/", "http://b.service-now.com", "https://c.service-now.com/"])
    expect(await normalizeInstanceRows()).toBe(0)
  })
  it("merges collapsing rows: keeps the one with credentials and repoints MIDs", async () => {
    db.inst = [
      { id: "old", url: "https://a.service-now.com", midPasswordEnc: null },
      { id: "cred", url: "https://a.service-now.com/", midPasswordEnc: "enc" },
    ]
    db.mids = [{ name: "m", instanceId: "old" }]
    await normalizeInstanceRows()
    expect(db.inst).toHaveLength(1)
    expect(db.inst[0]).toMatchObject({ id: "cred", url: "https://a.service-now.com/" })
    expect(db.mids[0].instanceId).toBe("cred")
  })
})
