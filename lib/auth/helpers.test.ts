import { it, expect, describe, vi, beforeEach } from "vitest"
import { responseOrRethrow } from "@/lib/auth/helpers"

it("returns a thrown Response", () => {
  const r = new Response("x", { status: 401 })
  expect(responseOrRethrow(r)).toBe(r)
})

it("rethrows anything that is not a Response", () => {
  const e = new Error("db down")
  expect(() => responseOrRethrow(e)).toThrow(e)
})

import { signToken } from "@/lib/auth/jwt"

let cookieValue: string | undefined
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }) }))
type DbUser = { email: string; role: string; lockedAt: Date | null; sessionsValidAfter: Date | null } | null
let dbUser: DbUser
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique: vi.fn(async () => dbUser) } } }))

describe("session revalidation against the DB", () => {
  beforeEach(async () => {
    dbUser = { email: "a@x.com", role: "admin", lockedAt: null, sessionsValidAfter: null }
    cookieValue = await signToken({ userId: "u1", email: "stale@x.com", role: "admin" })
  })

  it("uses the DB's email and role, not the token's", async () => {
    dbUser = { ...dbUser!, role: "member" }
    const { getSessionUser } = await import("@/lib/auth/helpers")
    expect(await getSessionUser()).toMatchObject({ userId: "u1", email: "a@x.com", role: "member" })
  })

  it("deleted user -> requireUser throws 401", async () => {
    dbUser = null
    const { requireUser } = await import("@/lib/auth/helpers")
    await expect(requireUser()).rejects.toMatchObject({ status: 401 })
  })

  it("demoted admin -> requireAdmin throws 403", async () => {
    dbUser = { ...dbUser!, role: "member" }
    const { requireAdmin } = await import("@/lib/auth/helpers")
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 })
  })

  it("locked user -> 401", async () => {
    dbUser = { ...dbUser!, lockedAt: new Date() }
    const { requireUser } = await import("@/lib/auth/helpers")
    await expect(requireUser()).rejects.toMatchObject({ status: 401 })
  })

  it("a lock older than 15 minutes has expired and no longer revokes the session (I3)", async () => {
    dbUser = { ...dbUser!, lockedAt: new Date(Date.now() - 16 * 60_000) }
    const { requireUser } = await import("@/lib/auth/helpers")
    await expect(requireUser()).resolves.toMatchObject({ userId: "u1" })
  })

  it("token issued before sessionsValidAfter -> 401; a later login still works", async () => {
    const { requireUser } = await import("@/lib/auth/helpers")
    dbUser = { ...dbUser!, sessionsValidAfter: new Date(Date.now() + 60_000) }
    await expect(requireUser()).rejects.toMatchObject({ status: 401 })
    cookieValue = await signToken({ userId: "u1", email: "a@x.com", role: "admin", authAt: Math.floor(Date.now() / 1000) + 120 })
    await expect(requireUser()).resolves.toMatchObject({ userId: "u1" })
  })
})
