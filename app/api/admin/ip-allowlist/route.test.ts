import { it, expect, vi, beforeEach } from "vitest"

const findMany = vi.fn(async () => [{ id: "r1", cidr: "10.0.0.0/8", note: "", createdAt: new Date(0) }])
const findUnique = vi.fn(async () => null as unknown)
const create = vi.fn(async ({ data }: { data: { cidr: string; note: string } }) => ({ id: "r2", ...data }))
const deleteMany = vi.fn(async () => ({ count: 1 }))
vi.mock("@/lib/db/client", () => ({ prisma: { ipAllowlist: { findMany, findUnique, create, deleteMany } } }))
const recordAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit }))

let role: "admin" | "member" | null = "admin"
let boom: Error | null = null
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireAdmin: vi.fn(async () => {
    if (boom) throw boom
    if (!role) throw new Response("{}", { status: 401 })
    if (role !== "admin") throw new Response("{}", { status: 403 })
    return { userId: "u1", email: "a@x.com", role }
  }),
}))

beforeEach(() => { role = "admin"; boom = null; create.mockClear(); deleteMany.mockClear(); recordAudit.mockClear(); findUnique.mockResolvedValue(null) })

const post = (body: unknown) =>
  new Request("http://x/midhub/api/admin/ip-allowlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

it("GET returns entries and the caller's IP", async () => {
  const { GET } = await import("./route")
  const res = await GET(new Request("http://x/", { headers: { "x-forwarded-for": "10.9.9.9, 1.1.1.1" } }))
  const j = await res.json()
  expect(j.myIp).toBe("10.9.9.9")
  expect(j.entries).toHaveLength(1)
})

it("401 when signed out, 403 for a member", async () => {
  const { GET, POST, DELETE } = await import("./route")
  role = null
  expect((await GET(new Request("http://x/"))).status).toBe(401)
  role = "member"
  expect((await POST(post({ cidr: "10.0.0.0/8" }))).status).toBe(403)
  expect((await DELETE(new Request("http://x/?id=r1", { method: "DELETE" }))).status).toBe(403)
  expect(create).not.toHaveBeenCalled()
  expect(deleteMany).not.toHaveBeenCalled()
})

it("a real error from requireAdmin becomes a logged 500 { code: internal }, never a fake Response", async () => {
  const { GET } = await import("./route")
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  boom = new Error("db down")
  const res = await GET(new Request("http://x/"))
  expect(res.status).toBe(500)
  expect(await res.json()).toMatchObject({ code: "internal", detail: "db down" })
  expect(log).toHaveBeenCalled()
  log.mockRestore()
})

it("POST accepts IPv4 and IPv6, rejects invalid CIDR", async () => {
  const { POST } = await import("./route")
  expect((await POST(post({ cidr: "10.0.0.0/8", note: "office" }))).status).toBe(201)
  expect((await POST(post({ cidr: "2001:db8::/32" }))).status).toBe(201)
  expect((await POST(post({ cidr: "10.0.0.0/33" }))).status).toBe(400)
  expect((await POST(post({ cidr: "nope" }))).status).toBe(400)
  expect((await POST(post({}))).status).toBe(400)
  expect(create).toHaveBeenCalledTimes(2)
})

it("POST 409s on a duplicate", async () => {
  const { POST } = await import("./route")
  findUnique.mockResolvedValue({ id: "r1" })
  expect((await POST(post({ cidr: "10.0.0.0/8" }))).status).toBe(409)
})

it("DELETE removes by id", async () => {
  const { DELETE } = await import("./route")
  findUnique.mockResolvedValue({ id: "r1", cidr: "10.0.0.0/8" })
  expect((await DELETE(new Request("http://x/?id=r1", { method: "DELETE" }))).status).toBe(200)
  expect(deleteMany).toHaveBeenCalledWith({ where: { id: "r1" } })
  expect((await DELETE(new Request("http://x/", { method: "DELETE" }))).status).toBe(400)
})

it("POST 409s when the unique constraint is hit concurrently (P2002)", async () => {
  const { POST } = await import("./route")
  create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
  expect((await POST(post({ cidr: "10.0.0.0/8" }))).status).toBe(409)
})

it("add and remove are audited (I2); removing an unknown id is a 404 and not audited", async () => {
  const { POST, DELETE } = await import("./route")
  await POST(post({ cidr: " 10.1.0.0/16 ", note: "vpn" }))
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "ip_allowlist.add", undefined, { cidr: "10.1.0.0/16", note: "vpn" })
  findUnique.mockResolvedValue({ id: "r1", cidr: "10.1.0.0/16" })
  await DELETE(new Request("http://x/?id=r1", { method: "DELETE" }))
  expect(recordAudit).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "u1" }), "ip_allowlist.remove", undefined, { cidr: "10.1.0.0/16" })
  recordAudit.mockClear()
  findUnique.mockResolvedValue(null)
  const res = await DELETE(new Request("http://x/?id=gone", { method: "DELETE" }))
  expect(res.status).toBe(404)
  expect(await res.json()).toMatchObject({ code: "not_found" })
  expect(recordAudit).not.toHaveBeenCalled()
})
