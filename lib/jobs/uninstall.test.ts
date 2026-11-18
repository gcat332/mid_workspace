import { it, expect, beforeAll, afterAll, beforeEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, readdirSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "midhub-uninstall-"))
const dbUrl = `file:${join(dir, "t.db")}`
const root = join(dir, "root")
process.env.DATABASE_URL = dbUrl
process.env.MIDHUB_ROOT = root
process.env.JWT_SECRET = "x".repeat(40)
process.env.ADMIN_EMAIL = "a@x.com"
process.env.ADMIN_PASSWORD = "pw"
process.env.MIDHUB_VAULT_KEY = Buffer.alloc(32, 7).toString("base64")

const admin = { userId: "admin1", email: "a@x.com", role: "admin" as const }
let eng: typeof import("./engine")
let un: typeof import("./uninstall")
let prisma: typeof import("@/lib/db/client").prisma
let calls: string[] = []
let failOn: { op: string; times: number; err?: () => Error } | null = null
const outside = join(dir, "outside")
const tarList = (f: string) => execFileSync("/usr/bin/tar", ["-tzvf", f], { encoding: "utf8" })
const archives = () => (existsSync(join(root, "archive")) ? readdirSync(join(root, "archive")) : [])

beforeAll(async () => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" })
  ;({ prisma } = await import("@/lib/db/client"))
  eng = await import("./engine")
  un = await import("./uninstall")
  Object.assign(un.deps, {
    callHelper: async (req: { op: string }) => {
      calls.push(req.op)
      if (failOn && failOn.op === req.op && failOn.times-- > 0) throw failOn.err?.() ?? new Error("boom")
      return { ok: true as const }
    },
    gcPackages: async () => (calls.push("gc"), []),
  })
}, 60000)

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await eng.__idleForTests()
  eng.__resetForTests()
  un.registerUninstallKinds()
  un.registerUninstallKinds()
  calls = []
  failOn = null
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  mkdirSync(join(root, "mids"), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, "precious.txt"), "keep")
  await prisma.job.deleteMany()
  await prisma.midServer.deleteMany()
})

async function mkMid(name: string, state = "installed", tree = true) {
  await prisma.midServer.create({ data: { name, dir: `/x/${name}`, serviceName: `midhub-mid-${name}.service`, state, createdBy: "admin1" } })
  if (!tree) return
  const a = join(root, "mids", name, "agent")
  for (const d of ["bin", "lib", "jre", "logs", "conf", "extlib", "security", "properties"]) mkdirSync(join(a, d), { recursive: true })
  writeFileSync(join(a, "config.xml"), "<parameters/>")
  writeFileSync(join(a, "lib", "big.jar"), Buffer.alloc(2 * 1024 * 1024, 1))
  writeFileSync(join(a, "jre", "java"), "x")
  writeFileSync(join(a, "bin", "mid.sh"), "x")
  writeFileSync(join(a, "logs", "agent0.log.0"), "log line")
  writeFileSync(join(a, "conf", "wrapper-override.conf"), "x")
  writeFileSync(join(a, "properties", "glide.properties"), "x")
  writeFileSync(join(a, "security", "agent_keystore"), "secret", { mode: 0o600 })
  symlinkSync(outside, join(a, "extlib", "out"))
  execFileSync("/usr/bin/mkfifo", [join(a, "logs", "pipe")])
}
const run = async (kind: "uninstall" | "cancel_install", name: string) => {
  const j = await eng.createJob(admin, kind, name, { midId: null })
  await eng.__idleForTests()
  return prisma.job.findUniqueOrThrow({ where: { id: j.id } })
}

describe("uninstall", () => {
  it("lean archive, symlink preserved, outside untouched, helper order, row removed", async () => {
    await mkMid("u1")
    const job = await run("uninstall", "u1")
    expect(job.status).toBe("succeeded")
    expect(calls).toEqual(["stop", "removeUnit", "fixOwnership", "gc"])
    expect(existsSync(join(root, "mids", "u1"))).toBe(false)
    expect(existsSync(join(outside, "precious.txt"))).toBe(true)
    const row = await prisma.midServer.findUniqueOrThrow({ where: { name: "u1" } })
    expect(row.state).toBe("removed")
    expect(row.removedAt).toBeTruthy()
    const files = archives()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^u1-\d{8}-\d{6}\.tar\.gz$/)
    const f = join(root, "archive", files[0])
    expect(statSync(f).mode & 0o777).toBe(0o640)
    const list = tarList(f)
    expect(list).toContain("agent/config.xml")
    expect(list).toContain("agent/logs/agent0.log.0")
    expect(list).toContain("agent/security/agent_keystore")
    expect(list).toContain("agent/logs/pipe") // FIFO archived as special entry, tar did not hang
    expect(list).toMatch(/^l.* agent\/extlib\/out -> .*outside$/m)
    expect(list).not.toContain("agent/lib")
    expect(list).not.toContain("agent/jre")
    expect(list).not.toContain("agent/bin")
  })

  it("skips top-level symlinked entries", async () => {
    await mkMid("u2")
    const a = join(root, "mids", "u2", "agent")
    rmSync(join(a, "security"), { recursive: true })
    symlinkSync(outside, join(a, "security"))
    await run("uninstall", "u2")
    const list = tarList(join(root, "archive", archives()[0]))
    expect(list).not.toContain("precious")
    expect(list).not.toContain("agent/security")
    expect(existsSync(join(outside, "precious.txt"))).toBe(true)
  })

  it("resumes after a crash at deleteDir (retry completes, no second failure)", async () => {
    await mkMid("u3")
    const real = un.deps.callHelper
    failOn = { op: "fixOwnership", times: 1 }
    const job = await run("uninstall", "u3")
    expect(job).toMatchObject({ status: "failed", stage: "fixOwnership" })
    failOn = null
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("succeeded")
    expect(existsSync(join(root, "mids", "u3"))).toBe(false)
    expect(un.deps.callHelper).toBe(real)
  })

  it("deleteDir is a no-op when already gone; rerunning markRemoved path works", async () => {
    await mkMid("u4", "installed", false)
    await un.deleteMidDir("u4")
    const job = await run("uninstall", "u4")
    expect(job.status).toBe("succeeded")
    expect(archives()).toHaveLength(0)
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "u4" } })).state).toBe("removed")
  })

  it("not_found from helper (unit/dir never existed) does not fail stages", async () => {
    await mkMid("u5", "installed", false)
    const { MidError } = await import("@/lib/mids/names")
    failOn = { op: "stop", times: 9, err: () => new MidError("not_found") }
    const job = await run("uninstall", "u5")
    expect(job.status).toBe("succeeded")
  })

  it("other helper errors fail the job", async () => {
    await mkMid("u6")
    failOn = { op: "removeUnit", times: 9 }
    const job = await run("uninstall", "u6")
    expect(job).toMatchObject({ status: "failed", stage: "removeUnit" })
    expect(existsSync(join(root, "mids", "u6"))).toBe(true)
  })

  it("cancel_install creates no archive, tolerates missing dir", async () => {
    await mkMid("c1", "installing")
    const job = await run("cancel_install", "c1")
    expect(job.status).toBe("succeeded")
    expect(archives()).toHaveLength(0)
    expect(existsSync(join(root, "mids", "c1"))).toBe(false)
    await mkMid("c2", "installing", false)
    expect((await run("cancel_install", "c2")).status).toBe("succeeded")
  })

  it("archive over the size cap is aborted and removed", async () => {
    await mkMid("big")
    const a = join(root, "mids", "big", "agent", "logs")
    writeFileSync(join(a, "noise.bin"), Buffer.from(Array.from({ length: 4 * 1024 * 1024 }, () => Math.floor(Math.random() * 256))))
    un.limits.archiveMaxBytes = 1024 * 1024
    try {
      const job = await run("uninstall", "big")
      expect(job).toMatchObject({ status: "failed", stage: "archive" })
      expect(readFileSync(job.journalPath, "utf8")).toContain("1 GiB")
    } finally {
      un.limits.archiveMaxBytes = 1024 ** 3
    }
    expect(archives()).toHaveLength(0)
    expect(existsSync(join(root, "mids", "big"))).toBe(true)
  })
})

describe("archiveMid errors", () => {
  it("missing dir -> not_found", async () => {
    await expect(un.archiveMid("nope")).rejects.toMatchObject({ code: "not_found" })
  })
  it("aborted signal rejects", async () => {
    await mkMid("ab")
    const ac = new AbortController()
    ac.abort()
    await expect(un.archiveMid("ab", ac.signal)).rejects.toThrow()
    expect(archives().filter((n) => n.endsWith(".partial"))).toHaveLength(0)
  })
})

describe("sweepArchives", () => {
  it("deletes 31-day-old, keeps 29-day-old, skips symlinks and other names", async () => {
    const a = join(root, "archive")
    mkdirSync(a, { recursive: true })
    const now = new Date()
    const age = (f: string, days: number) => {
      const t = new Date(now.getTime() - days * 86400_000)
      utimesSync(f, t, t)
    }
    writeFileSync(join(a, "old.tar.gz"), "x")
    age(join(a, "old.tar.gz"), 31)
    writeFileSync(join(a, "new.tar.gz"), "x")
    age(join(a, "new.tar.gz"), 29)
    writeFileSync(join(a, "other.txt"), "x")
    age(join(a, "other.txt"), 90)
    writeFileSync(join(outside, "v.tar.gz"), "x")
    symlinkSync(join(outside, "v.tar.gz"), join(a, "link.tar.gz"))
    const gone = await un.sweepArchives(now)
    expect(gone.map((p) => p.split("/").pop())).toEqual(["old.tar.gz"])
    expect(readdirSync(a).sort()).toEqual(["link.tar.gz", "new.tar.gz", "other.txt"])
    expect(readFileSync(join(outside, "v.tar.gz"), "utf8")).toBe("x")
  })
  it("no archive dir -> []", async () => {
    expect(await un.sweepArchives()).toEqual([])
  })
})
