import { it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-reconcile-"))
const dbUrl = `file:${join(dir, "t.db")}`
process.env.DATABASE_URL = dbUrl
let prisma: typeof import("@/lib/db/client").prisma

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
})
afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

it("marks installing/uninstalling MIDs without an active or failed job as error; leaves the rest", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const mk = (name: string, state: string) => prisma.midServer.create({ data: { name, dir: "/x", serviceName: "s", state, createdBy: "t" } })
  const job = (midName: string, status: string) =>
    prisma.job.create({ data: { midName, kind: "install", stage: "s", status, params: "{}", journalPath: "x", createdBy: "t" } })
  await mk("orph1", "installing")
  await mk("orph2", "uninstalling")
  await mk("running1", "installing")
  await job("running1", "running")
  await mk("failed1", "installing")
  await job("failed1", "failed")
  await mk("cancelled1", "installing")
  await job("cancelled1", "cancelled")
  await mk("fine", "installed")
  const { reconcileOrphanedMids } = await import("./reconcile")
  expect((await reconcileOrphanedMids()).sort()).toEqual(["cancelled1", "orph1", "orph2"])
  const states = Object.fromEntries((await prisma.midServer.findMany()).map((m) => [m.name, m.state]))
  expect(states).toEqual({ orph1: "error", orph2: "error", running1: "installing", failed1: "installing", cancelled1: "error", fine: "installed" })
  const a = await prisma.auditLog.findMany({ where: { action: "mid.reconcile" } })
  expect(a.map((x) => x.midName).sort()).toEqual(["cancelled1", "orph1", "orph2"])
  expect((await reconcileOrphanedMids())).toEqual([])
})
