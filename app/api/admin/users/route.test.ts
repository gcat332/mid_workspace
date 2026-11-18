import { describe, it, expect, vi, beforeEach } from "vitest"

const row = { id: "u2", email: "m@x.com", role: "member", lockedAt: null, lastLoginAt: null, passwordHash: "SECRET" }
const findMany = vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) => [pick(row, select)])
const findUnique = vi.fn(async () => null as unknown)
// Like Prisma, honour `select` so a route that forgets it would leak passwordHash in these tests.
type Args = { data: Record<string, unknown>; select?: Record<string, boolean> }
const pick = (o: Record<string, unknown>, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, o[k]])) : o
const create = vi.fn(async ({ data, select }: Args) => pick({ id: "u3", lockedAt: null, lastLoginAt: null, ...data }, select))
const update = vi.fn(async ({ data, select }: Args) => pick({ ...row, ...data }, select))
const del = vi.fn(async () => row)
const count = vi.fn(async () => 2)
const userModel = { findMany, findUnique, create, update, delete: del, count }
const transaction = vi.fn(async (fn: (tx: { user: typeof userModel }) => unknown) => fn({ user: userModel }))
vi.mock("@/lib/db/client", () => ({ prisma: { user: userModel, $transaction: transaction } }))
const recordAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit }))

let role: "admin" | "member" | null = "admin"
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireAdmin: vi.fn(async () => {
    if (!role) throw new Response("{}", { status: 401 })
    if (role !== "admin") throw new Response("{}", { status: 403 })
    return { userId: "u1", email: "a@x.com", role }
  }),
}))

beforeEach(() => {
  role = "admin"
  for (const m of [create, update, del, findUnique, count, transaction, recordAudit]) m.mockClear()
  findUnique.mockResolvedValue(null); count.mockResolvedValue(2)
})

const json = (method: string, body?: unknown) =>
  new Request("http://x/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

it("403 for a member, 401 signed out", async () => {
  const { GET, POST } = await import("./route")
  const { PATCH, DELETE } = await import("./[id]/route")
  role = "member"
  expect((await GET()).status).toBe(403)
  expect((await POST(json("POST", { email: "a@b.c", role: "member" }))).status).toBe(403)
  expect((await PATCH(json("PATCH", { role: "admin" }), ctx("u2"))).status).toBe(403)
  expect((await DELETE(json("DELETE"), ctx("u2"))).status).toBe(403)
  role = null
  expect((await GET()).status).toBe(401)
  expect(create).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
})

it("GET never exposes passwordHash", async () => {
  const { GET } = await import("./route")
  const res = await GET()
  const text = JSON.stringify(await res.json())
  expect(text).not.toContain("passwordHash")
  expect(text).not.toContain("SECRET")
  expect(text).toContain("m@x.com")
})

it("POST lowercases email, hashes password, never returns hash", async () => {
  const { POST } = await import("./route")
  const res = await POST(json("POST", { email: "  New@X.COM ", role: "member", password: "longenough" }))
  expect(res.status).toBe(201)
  const data = create.mock.calls[0][0].data
  expect(data.email).toBe("new@x.com")
  expect(String(data.passwordHash)).toMatch(/^\$2[aby]\$/)
  expect(JSON.stringify(await res.json())).not.toContain("passwordHash")
})

it("POST without password stores a random unusable hash (SSO-only)", async () => {
  const { POST } = await import("./route")
  await POST(json("POST", { email: "a@x.com", role: "member" }))
  await POST(json("POST", { email: "b@x.com", role: "member" }))
  const [h1, h2] = create.mock.calls.map((c) => String(c[0].data.passwordHash))
  expect(h1).toMatch(/^\$2[aby]\$/)
  expect(h1).not.toBe(h2)
})

it("POST validates email, role, password length", async () => {
  const { POST } = await import("./route")
  expect((await POST(json("POST", { email: "nope", role: "member" }))).status).toBe(400)
  expect((await POST(json("POST", { email: "a@x.com", role: "root" }))).status).toBe(400)
  const res = await POST(json("POST", { email: "a@x.com", role: "member", password: "short" }))
  expect(res.status).toBe(400)
  expect((await res.json()).message).toContain("8")
  expect(create).not.toHaveBeenCalled()
})

it("POST 409s on duplicate, including a P2002 race", async () => {
  const { POST } = await import("./route")
  findUnique.mockResolvedValue({ id: "u2" })
  expect((await POST(json("POST", { email: "M@x.com", role: "member" }))).status).toBe(409)
  findUnique.mockResolvedValue(null)
  create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
  expect((await POST(json("POST", { email: "m@x.com", role: "member" }))).status).toBe(409)
})

it("PATCH changes role, unlocks, and sets password", async () => {
  const { PATCH } = await import("./[id]/route")
  findUnique.mockResolvedValue({ id: "u2", role: "member" })
  const res = await PATCH(json("PATCH", { role: "admin", unlock: true, password: "newpassword" }), ctx("u2"))
  expect(res.status).toBe(200)
  const data = update.mock.calls[0][0].data
  expect(data.role).toBe("admin")
  expect(data.lockedAt).toBeNull()
  expect(data.failedLoginCount).toBe(0)
  expect(String(data.passwordHash)).toMatch(/^\$2[aby]\$/)
  expect(JSON.stringify(await res.json())).not.toContain("passwordHash")
  expect((await PATCH(json("PATCH", { password: "x" }), ctx("u2"))).status).toBe(400)
})

it("PATCH 404 for unknown user", async () => {
  const { PATCH } = await import("./[id]/route")
  expect((await PATCH(json("PATCH", { role: "admin" }), ctx("nope"))).status).toBe(404)
})

it("admin cannot demote or delete themselves", async () => {
  const { PATCH, DELETE } = await import("./[id]/route")
  const msg = "ไม่สามารถลดสิทธิ์/ลบบัญชีตัวเองได้"
  const a = await PATCH(json("PATCH", { role: "member" }), ctx("u1"))
  expect(a.status).toBe(400); expect((await a.json()).message).toBe(msg)
  const b = await DELETE(json("DELETE"), ctx("u1"))
  expect(b.status).toBe(400); expect((await b.json()).message).toBe(msg)
  expect(update).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
})

it("cannot delete or demote the last admin", async () => {
  const { PATCH, DELETE } = await import("./[id]/route")
  findUnique.mockResolvedValue({ id: "u9", role: "admin" })
  count.mockResolvedValue(1)
  expect((await DELETE(json("DELETE"), ctx("u9"))).status).toBe(400)
  expect((await PATCH(json("PATCH", { role: "member" }), ctx("u9"))).status).toBe(400)
  expect(del).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
})

it("can delete or demote an admin when another admin remains", async () => {
  const { PATCH, DELETE } = await import("./[id]/route")
  findUnique.mockResolvedValue({ id: "u9", role: "admin" })
  expect((await PATCH(json("PATCH", { role: "member" }), ctx("u9"))).status).toBe(200)
  expect((await DELETE(json("DELETE"), ctx("u9"))).status).toBe(200)
  expect(del).toHaveBeenCalledWith({ where: { id: "u9" } })
})

it("PATCH {unlock:true} alone clears the lock only", async () => {
  const { PATCH } = await import("./[id]/route")
  findUnique.mockResolvedValue({ id: "u2", role: "member" })
  expect((await PATCH(json("PATCH", { unlock: true }), ctx("u2"))).status).toBe(200)
  expect(update.mock.calls[0][0].data).toEqual({ lockedAt: null, failedLoginCount: 0 })
})

it("PATCH rejects an invalid role and an empty body", async () => {
  const { PATCH } = await import("./[id]/route")
  expect((await PATCH(json("PATCH", { role: "root" }), ctx("u2"))).status).toBe(400)
  expect((await PATCH(json("PATCH", {}), ctx("u2"))).status).toBe(400)
  expect(update).not.toHaveBeenCalled()
})

it("POST with password:\"\" is SSO-only", async () => {
  const { POST } = await import("./route")
  expect((await POST(json("POST", { email: "s@x.com", role: "member", password: "" }))).status).toBe(201)
  expect(String(create.mock.calls[0][0].data.passwordHash)).toMatch(/^\$2[aby]\$/)
})

it("password reset for another user ends their sessions; self reset does not", async () => {
  const { PATCH } = await import("./[id]/route")
  findUnique.mockResolvedValue({ id: "u2", role: "member" })
  await PATCH(json("PATCH", { password: "newpassword" }), ctx("u2"))
  expect(update.mock.calls[0][0].data.sessionsValidAfter).toBeInstanceOf(Date)
  await PATCH(json("PATCH", { password: "newpassword" }), ctx("u1"))
  expect(update.mock.calls[1][0].data.sessionsValidAfter).toBeUndefined()
})

it("the last-admin check and the write run inside one transaction", async () => {
  const { PATCH, DELETE } = await import("./[id]/route")
  findUnique.mockResolvedValue({ id: "u9", role: "admin" })
  await PATCH(json("PATCH", { role: "member" }), ctx("u9"))
  await DELETE(json("DELETE"), ctx("u9"))
  expect(transaction).toHaveBeenCalledTimes(2)
  // Neither guard may touch the DB outside the transaction callback.
  transaction.mockClear(); count.mockClear(); findUnique.mockClear()
  transaction.mockImplementationOnce(async () => "last-admin" as never)
  const res = await DELETE(json("DELETE"), ctx("u9"))
  expect(res.status).toBe(400)
  expect(count).not.toHaveBeenCalled()
  expect(findUnique).not.toHaveBeenCalled()
})

it("unlock and password reset clear the in-memory login limiter for that email (Q-M7)", async () => {
  const { PATCH } = await import("./[id]/route")
  const { hitLoginLimiter } = await import("@/lib/auth/login-limiter")
  for (const body of [{ unlock: true }, { password: "newpassword" }]) {
    for (let i = 0; i < 6; i++) hitLoginLimiter("10.0.0.1", "m@x.com")
    expect(hitLoginLimiter("10.0.0.1", "m@x.com").limited).toBe(true)
    findUnique.mockResolvedValue({ id: "u2", role: "member", email: "m@x.com" })
    expect((await PATCH(json("PATCH", body), ctx("u2"))).status).toBe(200)
    expect(hitLoginLimiter("10.0.0.1", "m@x.com").limited).toBe(false)
  }
})

describe("admin actions are audited without secrets (I2)", () => {
  const me = expect.objectContaining({ userId: "u1", email: "a@x.com" })
  const noSecrets = () => {
    const all = JSON.stringify(recordAudit.mock.calls)
    expect(all).not.toContain("longenough")
    expect(all).not.toContain("newpassword")
    expect(all).not.toMatch(/\$2[aby]\$/)
    expect(all).not.toContain("passwordHash")
  }
  it("POST -> user.create", async () => {
    const { POST } = await import("./route")
    await POST(json("POST", { email: "New@x.com", role: "admin", password: "longenough" }))
    await POST(json("POST", { email: "sso@x.com", role: "member" }))
    expect(recordAudit).toHaveBeenNthCalledWith(1, me, "user.create", undefined, { targetEmail: "new@x.com", role: "admin", ssoOnly: false })
    expect(recordAudit).toHaveBeenNthCalledWith(2, me, "user.create", undefined, { targetEmail: "sso@x.com", role: "member", ssoOnly: true })
    noSecrets()
  })
  it("PATCH -> user.update with what changed", async () => {
    const { PATCH } = await import("./[id]/route")
    findUnique.mockResolvedValue({ id: "u2", role: "member", email: "m@x.com" })
    await PATCH(json("PATCH", { role: "admin", unlock: true, password: "newpassword" }), ctx("u2"))
    expect(recordAudit).toHaveBeenCalledWith(me, "user.update", undefined, { targetEmail: "m@x.com", role: "admin", unlock: true, passwordChanged: true })
    noSecrets()
  })
  it("DELETE -> user.delete", async () => {
    const { DELETE } = await import("./[id]/route")
    findUnique.mockResolvedValue({ id: "u2", role: "member", email: "m@x.com" })
    await DELETE(json("DELETE"), ctx("u2"))
    expect(recordAudit).toHaveBeenCalledWith(me, "user.delete", undefined, { targetEmail: "m@x.com", role: "member" })
  })
  it("refused changes are not audited; errors use { code, message } (M3)", async () => {
    const { PATCH } = await import("./[id]/route")
    const res = await PATCH(json("PATCH", { role: "member" }), ctx("u1"))
    expect(await res.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) })
    expect(recordAudit).not.toHaveBeenCalled()
  })
})
