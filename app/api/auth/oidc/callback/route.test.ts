import { it, expect, vi, beforeEach } from "vitest"

const idpGet = vi.fn()
vi.mock("@/lib/services/idp", () => ({ idpService: { get: () => idpGet() } }))
type Row = { id: string; email: string; role: string; lockedAt: Date | null }
let rows: Row[] = []
const findUnique = vi.fn(async ({ where }: { where: { email: string } }) => rows.find((r) => r.email === where.email) ?? null)
const update = vi.fn(async () => ({}))
const create = vi.fn()
vi.mock("@/lib/db/client", () => ({
  prisma: { user: { findUnique, update, create }, authLog: { create: vi.fn(async () => ({})) } },
}))
const verifyIdToken = vi.fn()
vi.mock("@/lib/auth/oidc", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/oidc")>()),
  discover: vi.fn(async () => ({ issuer: "iss", token_endpoint: "http://idp/token", jwks_uri: "http://idp/jwks" })),
  verifyIdToken: (...a: unknown[]) => verifyIdToken(...a),
}))
const jar: Record<string, string> = {}
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({ get: (n: string) => (n in jar ? { value: jar[n] } : undefined) }),
}))

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  for (const k of Object.keys(jar)) delete jar[k]
  Object.assign(jar, { oidc_state: "s1", oidc_nonce: "n1", oidc_verifier: "v", oidc_redirect: "http://x/cb" })
  rows = [{ id: "u1", email: "bob@x.com", role: "member", lockedAt: null }]
  idpGet.mockReset().mockResolvedValue({ enabled: true, issuer: "iss", clientId: "cid", clientSecret: "sec", redirectUri: "" })
  verifyIdToken.mockReset().mockResolvedValue({ nonce: "n1", email: "Bob@X.com" })
  create.mockClear()
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id_token: "t" }))))
})

const call = async (qs = "code=abc&state=s1") => {
  const { GET } = await import("./route")
  return GET(new Request(`http://x/midhub/api/auth/oidc/callback?${qs}`))
}

it("signs in a registered user (any email case) and redirects to /midhub with a session cookie", async () => {
  const res = await call()
  expect(res.headers.get("location")).toBe("http://x/midhub")
  const cookie = res.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("midhub_session=")
  expect(cookie).toContain("Path=/midhub")
})

it("honours a valid login_next cookie", async () => {
  jar.login_next = "/midhub/mids"
  const res = await call()
  expect(res.headers.get("location")).toBe("http://x/midhub/mids")
})

it("refuses an unregistered email and creates no user", async () => {
  verifyIdToken.mockResolvedValue({ nonce: "n1", email: "stranger@x.com" })
  const res = await call()
  expect(res.headers.get("location")).toBe("http://x/midhub/login?error=not_registered")
  expect(res.headers.get("set-cookie") ?? "").not.toContain("midhub_session=t")
  expect(create).not.toHaveBeenCalled()
})

it("refuses a locked user", async () => {
  rows[0].lockedAt = new Date()
  const res = await call()
  expect(res.headers.get("location")).toBe("http://x/midhub/login?error=locked")
})

it("refuses a bad state", async () => {
  const res = await call("code=abc&state=forged")
  expect(res.headers.get("location")).toBe("http://x/midhub/login?error=state")
})

it("refuses when the nonce cookie is missing (fail closed)", async () => {
  delete jar.oidc_nonce
  verifyIdToken.mockResolvedValue({ email: "bob@x.com" })
  const res = await call()
  expect(res.headers.get("location")).toBe("http://x/midhub/login?error=state")
  expect(res.headers.get("set-cookie") ?? "").not.toContain("midhub_session=ey")
})

it("refuses a nonce mismatch", async () => {
  verifyIdToken.mockResolvedValue({ nonce: "other", email: "bob@x.com" })
  const res = await call()
  expect(res.headers.get("location")).toBe("http://x/midhub/login?error=state")
})

it("never puts IdP-supplied text in the redirect", async () => {
  const res = await call("error=access_denied&error_description=%3Cscript%3E")
  expect(res.headers.get("location")).toBe("http://x/midhub/login?error=idp")
})
