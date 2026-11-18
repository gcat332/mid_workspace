import { it, expect, vi, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Real SQLite: a temp DB built from the project's migrations, so orderBy/where/take are Prisma's own.
const dir = mkdtempSync(join(tmpdir(), "midhub-audit-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl

let role: "admin" | "member" | null = "admin"
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireAdmin: vi.fn(async () => {
    if (!role) throw new Response("{}", { status: 401 })
    if (role !== "admin") throw new Response("{}", { status: 403 })
    return { userId: "u1", email: "a@x.com", role }
  }),
}))

type Page = { items: { id: string; at: string; midName: string | null; email: string }[]; nextCursor: string | null }
const get = async (qs = "") => {
  const { GET } = await import("./route")
  return GET(new Request(`http://x/api/admin/audit${qs}`))
}
const page = async (qs = "") => (await get(qs)).json() as Promise<Page>

async function walk(extra = ""): Promise<Page["items"]> {
  const all: Page["items"] = []
  let cursor: string | null = null
  for (let i = 0; i < 20; i++) {
    const p: Page = await page(`?${extra}${cursor ? `&cursor=${cursor}` : ""}`)
    all.push(...p.items)
    if (!p.nextCursor) return all
    cursor = p.nextCursor
  }
  throw new Error("did not terminate")
}

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  const { prisma } = await import("@/lib/db/client")
  const base = Date.UTC(2026, 0, 1)
  const rows = Array.from({ length: 120 }, (_, i) => ({
    id: `id${String(i).padStart(3, "0")}`,
    // groups of 7 share one timestamp so pages cut through identical `at`
    at: new Date(base + Math.floor(i / 7) * 1000),
    email: i % 3 === 0 ? "Alice@x.com".toLowerCase() : "bob@corp.com",
    action: "config.save",
    midName: i % 4 === 0 ? "mid-a" : "mid-b",
    detail: "{}",
  }))
  await prisma.auditLog.createMany({ data: rows })
}, 60000)

afterAll(async () => {
  const { prisma } = await import("@/lib/db/client")
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

it("403 for a member, 401 signed out", async () => {
  role = "member"
  expect((await get()).status).toBe(403)
  role = null
  expect((await get()).status).toBe(401)
  role = "admin"
})

it("paginates 120 rows in 50/50/20, disjoint, complete and ordered (identical timestamps included)", async () => {
  const p1 = await page()
  expect(p1.items).toHaveLength(50)
  expect(p1.nextCursor).toBeTruthy()
  const p2 = await page(`?cursor=${p1.nextCursor}`)
  const p3 = await page(`?cursor=${p2.nextCursor}`)
  expect([p2.items.length, p3.items.length]).toEqual([50, 20])
  expect(p3.nextCursor).toBeNull()
  const ids = [...p1.items, ...p2.items, ...p3.items].map((r) => r.id)
  expect(new Set(ids).size).toBe(120)
  const sorted = [...ids].sort() // ids are zero-padded index; newest (at desc, id desc) = highest first
  expect(ids).toEqual(sorted.reverse())
})

it("filter by mid returns only that MID, still paginated", async () => {
  const all = await walk("mid=mid-a")
  expect(all).toHaveLength(30)
  expect(all.every((r) => r.midName === "mid-a")).toBe(true)
  expect(new Set(all.map((r) => r.id)).size).toBe(30)
})

it("user filter is a case-insensitive substring and combines with mid", async () => {
  const bob = await walk("user=BOB")
  expect(bob.length).toBe(80)
  expect(bob.every((r) => r.email.includes("bob"))).toBe(true)
  const both = await walk("user=%20ALICE%20&mid=mid-a")
  expect(both.length).toBeGreaterThan(0)
  expect(both.every((r) => r.email === "alice@x.com" && r.midName === "mid-a")).toBe(true)
})

it("400 invalid_request for a bad cursor or an over-long filter", async () => {
  for (const qs of ["?cursor=not-a-cursor", `?cursor=${Buffer.from('{"at":"x","id":1}').toString("base64url")}`, `?mid=${"a".repeat(101)}`]) {
    const res = await get(qs)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  }
})

it("treats % and _ in the user filter literally", async () => {
  const { prisma } = await import("@/lib/db/client")
  const at = new Date(Date.UTC(2020, 0, 1))
  await prisma.auditLog.createMany({ data: [
    { id: "w1", at, email: "a_c@x.com", action: "x", detail: "{}" },
    { id: "w2", at, email: "abc@x.com", action: "x", detail: "{}" },
  ] })
  const r = await walk("user=a_c")
  expect(r.map((x) => x.id)).toEqual(["w1"])
  expect((await walk("user=%25")).length).toBe(0)
})
