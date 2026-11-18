import { beforeEach, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }))
const upsert = vi.hoisted(() => vi.fn(async (d: Record<string, unknown>) => { store.row = { ...(store.row ?? {}), ...d } }))
vi.mock("@/lib/services/idp", async (orig) => ({
  ...(await orig<typeof import("@/lib/services/idp")>()),
  idpService: { get: async () => store.row, upsert },
}))
const recordAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit }))
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireAdmin: vi.fn(async () => ({ userId: "u1", email: "a@x.com", role: "admin" })),
}))

const put = (body: unknown) => new Request("http://x/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const full = { provider: "oidc", label: "SSO", enabled: true, issuer: "https://login.example.com/v2.0", clientId: "cid", clientSecret: "s3cr3t-value", tenantId: "", redirectUri: "", scopes: "openid profile email" }

beforeEach(() => { store.row = null; upsert.mockClear(); recordAudit.mockClear() })

it("enabling with missing issuer / client id / secret -> 400 naming every missing field, nothing saved (Q-I1)", async () => {
  const { PUT } = await import("./route")
  const res = await PUT(put({ ...full, issuer: "", clientId: " ", clientSecret: "" }))
  expect(res.status).toBe(400)
  const j = await res.json()
  expect(j.code).toBe("idp_incomplete")
  for (const f of ["Issuer URL", "Client ID", "Client Secret"]) expect(j.message).toContain(f)
  expect(upsert).not.toHaveBeenCalled()
})

it("enabling with a non-https issuer is refused", async () => {
  const { PUT } = await import("./route")
  const res = await PUT(put({ ...full, issuer: "http://login.example.com" }))
  expect(res.status).toBe(400)
  expect((await res.json()).message).toContain("https://")
})

it("a stored secret counts (placeholder or blank keeps it); a disabled draft may be incomplete", async () => {
  const { PUT } = await import("./route")
  store.row = { ...full, enabled: false }
  expect((await PUT(put({ ...full, clientSecret: "••••" }))).status).toBe(200)
  expect((await PUT(put({ ...full, clientSecret: "" }))).status).toBe(200)
  store.row = null
  expect((await PUT(put({ ...full, enabled: false, issuer: "", clientId: "", clientSecret: "" }))).status).toBe(200)
})

it("PUT is audited as idp.update without the secret (I2)", async () => {
  const { PUT } = await import("./route")
  await PUT(put(full))
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "idp.update", undefined, {
    enabled: true, provider: "oidc", issuer: "https://login.example.com/v2.0", clientId: "cid", secretChanged: true,
  })
  store.row = { ...full }
  await PUT(put({ ...full, clientSecret: "••••" }))
  expect(recordAudit).toHaveBeenLastCalledWith(expect.anything(), "idp.update", undefined, expect.objectContaining({ secretChanged: false }))
  expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("s3cr3t")
})
