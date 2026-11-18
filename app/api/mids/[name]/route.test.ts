import { it, expect, vi, beforeAll, afterAll, beforeEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-agentaccess-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = join(dir, "root")
process.env.JWT_SECRET = "x".repeat(40)
process.env.ADMIN_EMAIL = "a@x.com"
process.env.ADMIN_PASSWORD = "pw"

let signedIn = true
vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 })
    return { userId: "u1", email: "m@x.com", role: "member" }
  }),
}))

let prisma: typeof import("@/lib/db/client").prisma
const ctx = (name: string) => ({ params: Promise.resolve({ name }) })
const patch = async (name: string, body: unknown) =>
  (await import("./route")).PATCH(
    new Request("http://x/api/mids/" + name, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }),
    ctx(name),
  )
const mk = (name: string, state = "installed") =>
  prisma.midServer.create({ data: { name, dir: "/x", serviceName: "s", state, createdBy: "t" } })

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
})
afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  signedIn = true
  await prisma.auditLog.deleteMany()
  await prisma.midServer.deleteMany()
})

describe("PATCH /api/mids/[name] agentAccess", () => {
  it("defaults to false, toggles on and off, returns the value and audits", async () => {
    await mk("m1")
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m1" } })).agentAccess).toBe(false)
    let res = await patch("m1", { agentAccess: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agentAccess: true })
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m1" } })).agentAccess).toBe(true)
    res = await patch("m1", { agentAccess: false })
    expect(await res.json()).toEqual({ agentAccess: false })
    const rows = await prisma.auditLog.findMany({ where: { action: "mid.agent_access" }, orderBy: { at: "asc" } })
    expect(rows.map((r) => [r.midName, r.email, JSON.parse(r.detail)])).toEqual([
      ["m1", "m@x.com", { enabled: true }],
      ["m1", "m@x.com", { enabled: false }],
    ])
  })

  it("non-boolean, missing, extra keys, bad JSON -> 400 invalid_request and nothing changes", async () => {
    await mk("m1")
    for (const bad of [{ agentAccess: "true" }, { agentAccess: 1 }, {}, { agentAccess: true, state: "removed" }, { heapMb: 1 }, "nope", null]) {
      const res = await patch("m1", bad)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("invalid_request")
    }
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "m1" } })).agentAccess).toBe(false)
    expect(await prisma.auditLog.count()).toBe(0)
  })

  it("404 for unknown or removed MID; 401 when signed out", async () => {
    await mk("gone", "removed")
    expect((await patch("zz-nope", { agentAccess: true })).status).toBe(404)
    expect((await patch("gone", { agentAccess: true })).status).toBe(404)
    await mk("m1")
    signedIn = false
    expect((await patch("m1", { agentAccess: true })).status).toBe(401)
    expect(await prisma.auditLog.count()).toBe(0)
  })

  it("is allowed while a lifecycle job is active (any state except removed)", async () => {
    await mk("busy", "installing")
    expect((await patch("busy", { agentAccess: true })).status).toBe(200)
  })

  it("GET summary carries agentAccess", async () => {
    await mk("m1")
    await patch("m1", { agentAccess: true })
    const { listMids } = await import("@/lib/mids/registry")
    expect((await listMids()).find((m) => m.name === "m1")?.agentAccess).toBe(true)
  })
})
