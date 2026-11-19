import { it, expect, vi, beforeAll, afterAll, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-sse-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = join(dir, "root")
process.env.JWT_SECRET = "x".repeat(40)
process.env.MIDHUB_VAULT_KEY = "k"

vi.mock("@/lib/auth/helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/helpers")>()),
  requireUser: vi.fn(async () => ({ userId: "u1", email: "m@x.com", role: "member" })),
}))

let prisma: typeof import("@/lib/db/client").prisma
beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
})
afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

let savedSse: Record<string, number> | null = null
afterEach(async () => {
  if (savedSse) Object.assign((await import("./route")).sse, savedSse)
})
const saveSse = async () => {
  const { sse } = await import("./route")
  savedSse ??= { ...sse }
  return sse
}

const mkJob = (id: string, status: string) =>
  prisma.job.create({ data: { id, midName: "m", kind: "install", stage: "s", status, params: "{}", journalPath: "x", createdBy: "t" } })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

it("replays the journal, follows new lines, emits done on terminal status", async () => {
  const route = await import("./route")
  Object.assign(await saveSse(), { statusPollMs: 100, tailPollMs: 50, drainMs: 200 })
  const { appendJournal } = await import("@/lib/jobs/journal")
  await mkJob("j1", "running")
  await appendJournal("j1", { type: "stage", stage: "precheck" })
  await appendJournal("j1", { type: "log", msg: "ok", password: "hunter2" })
  const res = await route.GET(new Request("http://x"), ctx("j1"))
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  setTimeout(async () => {
    await appendJournal("j1", { type: "log", msg: "later" })
    await prisma.job.update({ where: { id: "j1" }, data: { status: "succeeded" } })
    await appendJournal("j1", { type: "done" })
  }, 150)
  const text = await res.text() // resolves only when the stream closes
  expect(text).toContain('"stage":"precheck"')
  expect(text).toContain('"msg":"later"')
  expect(text).toContain('"type":"done"')
  expect(text).not.toContain("hunter2")
  expect(text).toMatch(/event: done\ndata: \{"status":"succeeded"\}/)
})

it("terminal job with no journal closes with done", async () => {
  const route = await import("./route")
  await mkJob("j2", "failed")
  const text = await (await route.GET(new Request("http://x"), ctx("j2"))).text()
  expect(text).toContain("event: done")
})

it("404 unknown job; 429 when over the stream cap; aborting frees a slot", async () => {
  const route = await import("./route")
  expect((await route.GET(new Request("http://x"), ctx("nope"))).status).toBe(404)
  await mkJob("j3", "running")
  ;(await saveSse()).maxStreams = 1
  const ac = new AbortController()
  const first = await route.GET(new Request("http://x", { signal: ac.signal }), ctx("j3"))
  expect(first.status).toBe(200)
  const over = await route.GET(new Request("http://x"), ctx("j3"))
  expect(over.status).toBe(429)
  expect((await over.json()).code).toBe("stream_limit")
  ac.abort()
  await new Promise((r) => setTimeout(r, 50))
  const again = await route.GET(new Request("http://x", { signal: new AbortController().signal }), ctx("j3"))
  expect(again.status).toBe(200)
  await again.body?.cancel()
})

it("a non-ENOENT tail error sends event: error and closes the stream", async () => {
  const route = await import("./route")
  Object.assign(await saveSse(), { tailPollMs: 50 })
  await mkJob("j4", "running")
  const { journalPath } = await import("@/lib/jobs/journal")
  mkdirSync(journalPath("j4"), { recursive: true }) // a directory where the journal file should be: read fails with EISDIR
  vi.spyOn(console, "error").mockImplementation(() => {})
  const text = await (await route.GET(new Request("http://x"), ctx("j4"))).text()
  expect(text).toContain("event: error")
  expect(text).toContain("อ่านความคืบหน้า")
})
