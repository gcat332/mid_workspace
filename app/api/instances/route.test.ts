import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/env", () => ({ env: { vaultKey: Buffer.alloc(32, 7).toString("base64") } }))

type R = Record<string, unknown>
const rows: R[] = []
const instance = {
  findMany: vi.fn(async () => rows),
  findUnique: vi.fn(async ({ where }: { where: R }) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null),
  create: vi.fn(async ({ data }: { data: R }) => { const r = { id: "i" + rows.length, createdAt: new Date(0), ...data }; rows.push(r); return r }),
  update: vi.fn(async ({ where, data }: { where: R; data: R }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
  delete: vi.fn(async () => ({})),
}
const midServer = { count: vi.fn(async () => 0) }
const prismaMock = { instance, midServer, $transaction: async (fn: (tx: unknown) => unknown) => fn(prismaMock) }
vi.mock("@/lib/db/client", () => ({ prisma: prismaMock }))
const recordAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit }))

let role: "admin" | "member" | null = "admin"
vi.mock("@/lib/auth/helpers", async (orig) => {
  const o = await orig<typeof import("@/lib/auth/helpers")>()
  const member = async () => {
    if (!role) throw new Response("{}", { status: 401 })
    return { userId: "u1", email: "a@x.com", role }
  }
  return {
    ...o,
    requireUser: vi.fn(member),
    requireAdmin: vi.fn(async () => { const u = await member(); if (u.role !== "admin") throw new Response("{}", { status: 403 }); return u }),
  }
})

const fetchMock = vi.fn()
const ok = () => new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } })

beforeEach(() => {
  role = "admin"
  rows.length = 0
  vi.clearAllMocks()
  fetchMock.mockImplementation(async () => ok())
  vi.stubGlobal("fetch", fetchMock)
  midServer.count.mockResolvedValue(0)
})

const json = (method: string, body?: unknown) =>
  new Request("http://x/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const body = { label: "demo", url: "https://demo.service-now.com", midUser: "mid", password: "TopSecret!" }

describe("instances API", () => {
  it("member can GET/POST/test but not PATCH/DELETE; signed out is 401", async () => {
    const { GET, POST } = await import("./route")
    const { POST: TEST } = await import("./test/route")
    const { PATCH, DELETE } = await import("./[id]/route")
    role = "member"
    expect((await GET()).status).toBe(200)
    expect((await POST(json("POST", body))).status).toBe(201)
    expect((await TEST(json("POST", body))).status).toBe(200)
    expect((await PATCH(json("PATCH", { label: "x" }), ctx("i0"))).status).toBe(403)
    expect((await DELETE(json("DELETE"), ctx("i0"))).status).toBe(403)
    expect(instance.update).not.toHaveBeenCalled(); expect(instance.delete).not.toHaveBeenCalled()
    role = null
    expect((await GET()).status).toBe(401)
  })

  it("GET and POST never expose the password or its ciphertext; stored encrypted", async () => {
    const { GET, POST } = await import("./route")
    const created = await (await POST(json("POST", body))).json()
    expect(created).toMatchObject({ url: "https://demo.service-now.com/", midUser: "mid", hasPassword: true })
    const text = JSON.stringify(await (await GET()).json())
    expect(text).not.toMatch(/TopSecret|midPasswordEnc/)
    expect(String(rows[0].midPasswordEnc)).not.toContain("TopSecret")
  })

  it("audit detail holds only url and label", async () => {
    const { POST } = await import("./route")
    await POST(json("POST", body))
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), "instance.create", undefined, { url: "https://demo.service-now.com/", label: "demo" })
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("TopSecret")
  })

  it("rejects a bad URL with 400 without touching the network; duplicate url is 409", async () => {
    const { POST } = await import("./route")
    const bad = await POST(json("POST", { ...body, url: "https://evil.com" }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe("instance_url")
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await POST(json("POST", body))).status).toBe(201)
    expect((await POST(json("POST", body))).status).toBe(409)
  })

  it("bad credentials are not saved (401 -> instance_auth)", async () => {
    const { POST } = await import("./route")
    fetchMock.mockImplementation(async () => new Response("", { status: 401 }))
    const res = await POST(json("POST", body))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("instance_auth")
    expect(instance.create).not.toHaveBeenCalled()
  })

  it("PATCH adds credentials to a credential-less Phase 1 row (and tests them)", async () => {
    rows.push({ id: "p1", label: "h", url: "https://old.service-now.com/", midUser: null, midPasswordEnc: null, buildstamp: null, createdBy: "x", createdAt: new Date(0) })
    const { GET } = await import("./route")
    expect((await (await GET()).json())[0].hasPassword).toBe(false)
    const { PATCH } = await import("./[id]/route")
    const res = await PATCH(json("PATCH", { midUser: "mid", password: "pw1" }), ctx("p1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ hasPassword: true, midUser: "mid" })
    expect(fetchMock).toHaveBeenCalled()
    // user alone without any stored password -> 400
    rows.push({ id: "p2", label: "h", url: "https://o2.service-now.com/", midUser: null, midPasswordEnc: null, buildstamp: null, createdBy: "x", createdAt: new Date(0) })
    expect((await PATCH(json("PATCH", { midUser: "mid" }), ctx("p2"))).status).toBe(400)
  })

  it("PATCH rejects a bad buildstamp and over-long fields", async () => {
    rows.push({ id: "b1", label: "h", url: "https://b.service-now.com/", midUser: null, midPasswordEnc: null, buildstamp: null, createdBy: "x", createdAt: new Date(0) })
    const { PATCH } = await import("./[id]/route")
    const bs = await PATCH(json("PATCH", { buildstamp: "nonsense" }), ctx("b1"))
    expect(bs.status).toBe(400)
    expect((await bs.json()).code).toBe("invalid_buildstamp")
    expect((await PATCH(json("PATCH", { label: "x".repeat(101) }), ctx("b1"))).status).toBe(400)
    expect((await PATCH(json("PATCH", { midUser: "x".repeat(101), password: "p" }), ctx("b1"))).status).toBe(400)
    expect((await PATCH(json("PATCH", { midUser: "u", password: "p".repeat(257) }), ctx("b1"))).status).toBe(400)
  })

  it("getInstanceSecret returns the normalised url of a Phase 1 (no slash) row", async () => {
    const { encryptSecret } = await import("@/lib/vault")
    rows.push({ id: "g1", label: "h", url: "https://G.service-now.com", midUser: "mid", midPasswordEnc: encryptSecret("pw"), buildstamp: null, createdBy: "x", createdAt: new Date(0) })
    const { getInstanceSecret } = await import("@/lib/instances/service")
    expect(await getInstanceSecret("g1")).toMatchObject({ url: "https://g.service-now.com/", password: "pw" })
  })

  it("DELETE: 409 when a live MID uses it, else ok", async () => {
    rows.push({ id: "d1", label: "h", url: "https://d.service-now.com/", midUser: null, midPasswordEnc: null, buildstamp: null, createdBy: "x", createdAt: new Date(0) })
    const { DELETE } = await import("./[id]/route")
    midServer.count.mockResolvedValue(1)
    const res = await DELETE(json("DELETE"), ctx("d1"))
    expect(res.status).toBe(409)
    expect((await res.json()).message).toContain("ยังมี MID ที่ใช้ instance นี้อยู่")
    expect(midServer.count).toHaveBeenCalledWith({ where: { instanceId: "d1", removedAt: null } })
    midServer.count.mockResolvedValue(0)
    expect((await DELETE(json("DELETE"), ctx("d1"))).status).toBe(200)
    expect((await DELETE(json("DELETE"), ctx("nope"))).status).toBe(404)
  })
})
