import { describe, it, expect, vi, beforeEach } from "vitest"

// Users are AgentHub admins created on sign-in; this API only lists them and locks/unlocks them.
const row = { id: "u2", email: "m@x.com", role: "admin", lockedAt: null, lastLoginAt: null, passwordHash: "SECRET" }
// Like Prisma, honour `select` so a route that forgets it would leak passwordHash in these tests.
type Args = { where?: unknown; data: Record<string, unknown>; select?: Record<string, boolean> }
const pick = (o: Record<string, unknown>, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, o[k]])) : o
const findMany = vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) => [pick(row, select)])
const update = vi.fn(async ({ data, select }: Args) => pick({ ...row, ...data }, select))
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findMany, update } } }))
const recordAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit }))

let role: "admin" | "member" | null = "admin"
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireAdmin: vi.fn(async () => {
    if (!role) throw new Response("{}", { status: 401 })
    if (role !== "admin") throw new Response("{}", { status: 403 })
    return { userId: "u1", email: "a@x.com", role, ahAt: 1 }
  }),
}))

beforeEach(() => {
  role = "admin"
  for (const m of [update, recordAudit]) m.mockClear()
})

const json = (method: string, body?: unknown) =>
  new Request("http://x/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

it("admin only: 403 for a member, 401 signed out", async () => {
  const { GET } = await import("./route")
  const { PATCH } = await import("./[id]/route")
  role = "member"
  expect((await GET()).status).toBe(403)
  expect((await PATCH(json("PATCH", { unlock: true }), ctx("u2"))).status).toBe(403)
  role = null
  expect((await GET()).status).toBe(401)
  expect((await PATCH(json("PATCH", { lock: true }), ctx("u2"))).status).toBe(401)
  expect(update).not.toHaveBeenCalled()
})

it("GET lists email, last seen and lock state; never passwordHash", async () => {
  const { GET } = await import("./route")
  const res = await GET()
  const body = (await res.json()) as Record<string, unknown>[]
  expect(Object.keys(body[0]).sort()).toEqual(["email", "id", "lastLoginAt", "lockedAt"])
  expect(JSON.stringify(body)).not.toContain("SECRET")
})

it("create, edit, role, password and delete are gone", async () => {
  const list = await import("./route")
  const one = await import("./[id]/route")
  expect(Object.keys(list)).toEqual(["GET"])
  expect(Object.keys(one).sort()).toEqual(["PATCH", "POST"])
  expect(one.POST).toBe(one.PATCH) // POST = PATCH because the F5 WAF rejects PATCH; still lock/unlock only
  const { PATCH } = one
  for (const body of [{ role: "member" }, { password: "newpassword" }, { email: "x@y.z" }, {}, { lock: true, unlock: true }, { lock: "yes" }]) {
    const res = await PATCH(json("PATCH", body), ctx("u2"))
    expect(res.status, JSON.stringify(body)).toBe(400)
  }
  expect(update).not.toHaveBeenCalled()
})

it("PATCH {lock:true} locks (until unlocked), audited", async () => {
  const { PATCH } = await import("./[id]/route")
  const res = await PATCH(json("PATCH", { lock: true }), ctx("u2"))
  expect(res.status).toBe(200)
  const a = update.mock.calls[0][0]
  expect(a.where).toEqual({ id: "u2" })
  expect(a.data.lockedAt).toBeInstanceOf(Date)
  expect(JSON.stringify(await res.json())).not.toContain("SECRET")
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "user.update", undefined, { targetEmail: "m@x.com", lock: true })
})

it("PATCH {unlock:true} clears the lock, audited", async () => {
  const { PATCH } = await import("./[id]/route")
  expect((await PATCH(json("PATCH", { unlock: true }), ctx("u2"))).status).toBe(200)
  expect(update.mock.calls[0][0].data).toEqual({ lockedAt: null, failedLoginCount: 0 })
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "user.update", undefined, { targetEmail: "m@x.com", unlock: true })
})

it("an admin cannot lock themselves", async () => {
  const { PATCH } = await import("./[id]/route")
  const res = await PATCH(json("PATCH", { lock: true }), ctx("u1"))
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ code: "self", message: expect.any(String) })
  expect(update).not.toHaveBeenCalled()
  expect(recordAudit).not.toHaveBeenCalled()
})

it("PATCH 404 for an unknown user (P2025)", async () => {
  const { PATCH } = await import("./[id]/route")
  update.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "P2025" }))
  const res = await PATCH(json("PATCH", { unlock: true }), ctx("nope"))
  expect(res.status).toBe(404)
  expect(recordAudit).not.toHaveBeenCalled()
})

describe("the users page is read-only apart from lock/unlock", () => {
  it("UsersManager has no create/role/password/delete controls", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../../../../components/UsersManager.tsx", import.meta.url), "utf8")
    for (const gone of ["รหัสผ่าน", "เพิ่ม", "ลบผู้ใช้", "เลื่อนเป็น", "ลดเป็น", '"DELETE"', "password"]) expect(src, gone).not.toContain(gone)
    // POST appears once: the lock/unlock call (sent as POST because the F5 WAF rejects PATCH), not a create.
    expect(src.match(/"POST"/g) ?? []).toHaveLength(1)
    expect(src).toContain("JSON.stringify(lock ? { lock: true } : { unlock: true })")
    expect(src).toContain("ปลดล็อก")
    expect(src).toContain("ล็อก")
  })
})
