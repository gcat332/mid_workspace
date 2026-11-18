import { it, expect, vi, beforeEach } from "vitest"
import bcrypt from "bcryptjs"

type Row = { id: string; email: string; passwordHash: string; role: string; failedLoginCount: number; lockedAt: Date | null }
let rows: Row[] = []
const findUnique = vi.fn(async ({ where }: { where: { email: string } }) => rows.find((r) => r.email === where.email) ?? null)
const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
  const r = rows.find((x) => x.id === where.id)!
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) (r as Record<string, unknown>)[k] = (r as unknown as Record<string, number>)[k] + (v as { increment: number }).increment
    else (r as Record<string, unknown>)[k] = v
  }
  return r
})
const authLogCreate = vi.fn(async () => ({}))
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique, update }, authLog: { create: authLogCreate } } }))
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({ get: () => undefined }) }))

const hash = bcrypt.hashSync("right-pass", 4)
beforeEach(() => {
  rows = [{ id: "u1", email: "admin@x.com", passwordHash: hash, role: "admin", failedLoginCount: 0, lockedAt: null }]
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

let n = 0
const post = (body: object, ip = `10.0.0.${++n}`) =>
  new Request("http://x/midhub/api/auth/login", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

it("logs in with the right password and sets the midhub_session cookie on /midhub", async () => {
  const { POST } = await import("./route")
  const res = await POST(post({ email: "admin@x.com", password: "right-pass" }))
  expect(res.status).toBe(200)
  const cookie = res.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("midhub_session=")
  expect(cookie).toContain("Path=/midhub")
})

it("matches the email case-insensitively", async () => {
  const { POST } = await import("./route")
  const res = await POST(post({ email: "ADMIN@X.COM", password: "right-pass" }))
  expect(res.status).toBe(200)
  expect((await res.json()).email).toBe("admin@x.com")
})

it("locks after 3 wrong passwords: 4th attempt is 423 even with the right password", async () => {
  const { POST } = await import("./route")
  const ip = "10.9.9.9"
  const statuses: number[] = []
  for (let i = 0; i < 3; i++) statuses.push((await POST(post({ email: "admin@x.com", password: "bad" }, ip))).status)
  expect(statuses).toEqual([401, 401, 423])
  const res = await POST(post({ email: "admin@x.com", password: "right-pass" }, ip))
  expect(res.status).toBe(423)
})

it("unknown email and wrong password return the same 401 body", async () => {
  const { POST } = await import("./route")
  const a = await POST(post({ email: "nobody@x.com", password: "bad" }))
  const b = await POST(post({ email: "admin@x.com", password: "bad" }))
  expect(a.status).toBe(401)
  expect(b.status).toBe(401)
  expect(await a.json()).toEqual(await b.json())
})
