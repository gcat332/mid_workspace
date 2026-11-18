import { it, expect, beforeAll, afterAll, beforeEach, describe } from "vitest"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, truncateSync, mkdirSync as mk2, openSync, closeSync, linkSync, writeSync, existsSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, readdirSync, statSync, readFileSync } from "node:fs"
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
let failOn: { op: string; times: number; skip?: number; err?: () => Error } | null = null
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
      if (failOn && failOn.op === req.op) {
        if ((failOn.skip ?? 0) > 0) failOn.skip!--
        else if (failOn.times-- > 0) throw failOn.err?.() ?? new Error("boom")
      }
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

async function mkMid(name: string, state = "uninstalling", tree = true) {
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
    await prisma.midServer.update({ where: { name: "u1" }, data: { agentAccess: true } })
    const job = await run("uninstall", "u1")
    expect(job.status).toBe("succeeded")
    expect(calls).toEqual(["stop", "removeUnit", "fixOwnership", "fixOwnership", "gc"])
    expect(existsSync(join(root, "mids", "u1"))).toBe(false)
    expect(existsSync(join(outside, "precious.txt"))).toBe(true)
    const row = await prisma.midServer.findUniqueOrThrow({ where: { name: "u1" } })
    expect(row.state).toBe("removed")
    expect(row.removedAt).toBeTruthy()
    expect(row.agentAccess).toBe(false)
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

  it("retry after a helper failure in the archive stage completes", async () => {
    await mkMid("u3")
    failOn = { op: "fixOwnership", times: 1 }
    const job = await run("uninstall", "u3")
    expect(job).toMatchObject({ status: "failed", stage: "archive" })
    failOn = null
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("succeeded")
    expect(existsSync(join(root, "mids", "u3"))).toBe(false)
    expect(archives()).toHaveLength(1)
  })

  it("retry at deleteDir over a partially removed tree completes", async () => {
    await mkMid("u3b")
    failOn = { op: "fixOwnership", times: 1, skip: 1 } // 2nd call = deleteDir stage
    const job = await run("uninstall", "u3b")
    expect(job).toMatchObject({ status: "failed", stage: "deleteDir" })
    const a = join(root, "mids", "u3b", "agent")
    rmSync(join(a, "lib"), { recursive: true })
    rmSync(join(a, "jre"), { recursive: true })
    failOn = null
    calls = []
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
    expect(existsSync(join(root, "mids", "u3b"))).toBe(false)
    expect(calls).toEqual(["fixOwnership", "gc"])
    expect(existsSync(join(outside, "precious.txt"))).toBe(true)
  })

  it("stale retry against a re-installed MID throws conflict and leaves the tree", async () => {
    await mkMid("u3c")
    failOn = { op: "fixOwnership", times: 1, skip: 1 }
    const job = await run("uninstall", "u3c")
    expect(job).toMatchObject({ status: "failed", stage: "deleteDir" })
    await prisma.midServer.update({ where: { name: "u3c" }, data: { state: "installed" } })
    failOn = null
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("failed")
    expect(readFileSync(after.journalPath, "utf8")).toContain("conflict")
    expect(existsSync(join(root, "mids", "u3c", "agent", "config.xml"))).toBe(true)
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "u3c" } })).state).toBe("installed")
    // a different row (same name re-created) is also rejected
    await prisma.midServer.delete({ where: { name: "u3c" } })
    await mkMid("u3c", "uninstalling", false)
    await eng.retryJob(admin, job.id).catch(() => undefined)
    await eng.__idleForTests()
    expect(existsSync(join(root, "mids", "u3c", "agent", "config.xml"))).toBe(true)
  })

  it("deleteDir is a no-op when the dir is already gone; the job still completes", async () => {
    await mkMid("u4", "uninstalling", false)
    await un.deleteMidDir("u4")
    const job = await run("uninstall", "u4")
    expect(job.status).toBe("succeeded")
    expect(archives()).toHaveLength(0)
    expect((await prisma.midServer.findUniqueOrThrow({ where: { name: "u4" } })).state).toBe("removed")
  })

  it("not_found from helper (unit/dir never existed) does not fail stages", async () => {
    await mkMid("u5", "uninstalling", false)
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

describe("best-effort archive and hardening", () => {
  it("sparse 4 GiB file is skipped quickly with a warning; uninstall continues", async () => {
    await mkMid("sp")
    const f = join(root, "mids", "sp", "agent", "logs", "huge.log")
    writeFileSync(f, "")
    truncateSync(f, 4 * 1024 ** 3)
    const t0 = Date.now()
    const job = await run("uninstall", "sp")
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(job.status).toBe("succeeded")
    expect(readFileSync(job.journalPath, "utf8")).toContain("ข้ามการเก็บ archive: ข้อมูลใหญ่เกิน 2 GB")
    expect(archives()).toHaveLength(0)
    expect(existsSync(join(root, "mids", "sp"))).toBe(false)
  })

  it("too many entries is skipped", async () => {
    await mkMid("many")
    const prev = un.limits.maxEntries
    un.limits.maxEntries = 5
    try {
      const job = await run("uninstall", "many")
      expect(job.status).toBe("succeeded")
      expect(readFileSync(job.journalPath, "utf8")).toContain("ข้ามการเก็บ archive")
    } finally {
      un.limits.maxEntries = prev
    }
  })

  it("tar failure fails the first attempt; the retry skips the archive with a warning", async () => {
    await mkMid("rt")
    writeFileSync(join(root, "mids", "rt", "agent", "logs", "noise.bin"), randomBytes(64 * 1024))
    un.limits.archiveMaxBytes = 1024
    let job
    try {
      job = await run("uninstall", "rt")
      expect(job).toMatchObject({ status: "failed", stage: "archive" })
      await eng.retryJob(admin, job.id)
      await eng.__idleForTests()
    } finally {
      un.limits.archiveMaxBytes = 1024 ** 3
    }
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("succeeded")
    expect(readFileSync(after.journalPath, "utf8")).toContain("ข้ามการเก็บ archive หลังพยายามซ้ำ")
    expect(archives()).toHaveLength(0)
    expect(existsSync(join(root, "mids", "rt"))).toBe(false)
  })

  it("hard links restore after extracting the archive (link target renamed too)", async () => {
    await mkMid("hl")
    const c = join(root, "mids", "hl", "agent", "conf")
    writeFileSync(join(c, "a.conf"), "same")
    linkSync(join(c, "a.conf"), join(c, "b.conf"))
    const p = await un.archiveMid("hl")
    const ex = join(dir, "ex")
    mkdirSync(ex)
    execFileSync("/usr/bin/tar", ["-xzf", p!, "-C", ex, "agent/conf"])
    expect(statSync(join(ex, "agent/conf/a.conf")).ino).toBe(statSync(join(ex, "agent/conf/b.conf")).ino)
    rmSync(ex, { recursive: true })
  })

  it("aborting mid-stream kills tar and removes the .partial file", async () => {
    await mkMid("am")
    const f = join(root, "mids", "am", "agent", "logs", "rand.bin")
    const fd = openSync(f, "w")
    for (let i = 0; i < 40; i++) writeSync(fd, randomBytes(4 * 1024 * 1024))
    closeSync(fd)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 150)
    await expect(un.archiveMid("am", ac.signal)).rejects.toThrow()
    expect(readdirSync(join(root, "archive"))).toEqual([])
  })

  it("deleteMidDir removes a ~2500-deep tree (beyond PATH_MAX)", async () => {
    await mkMid("deep", "uninstalling", false)
    const { openDirIn } = await import("@/lib/mids/safe-fs")
    const fsp = await import("node:fs/promises")
    const base = join(root, "mids", "deep")
    mk2(base)
    let h = await fsp.open(base, "r")
    for (let i = 0; i < 2500; i++) {
      await fsp.mkdir(`/proc/self/fd/${h.fd}/d`)
      await fsp.writeFile(`/proc/self/fd/${h.fd}/f`, "x")
      const n = await openDirIn(h, "d")
      await h.close()
      h = n
    }
    await h.close()
    await un.deleteMidDir("deep")
    expect(existsSync(base)).toBe(false)
  }, 60_000)
  it("deleteMidDir removes 5000 sibling directories quickly (linear, not quadratic)", async () => {
    await mkMid("wide", "uninstalling", false)
    const base = join(root, "mids", "wide", "agent", "extlib")
    mk2(base, { recursive: true })
    for (let i = 0; i < 5000; i++) mk2(join(base, `d${i}`))
    const t0 = Date.now()
    await un.deleteMidDir("wide")
    expect(Date.now() - t0).toBeLessThan(15_000) // linear ~4s alone, ~7s under suite load; the quadratic version needs ~35s
    expect(existsSync(join(root, "mids", "wide"))).toBe(false)
  }, 60_000)

  it("an old failed cancel_install is rejected once a newer job for the same name exists", async () => {
    await mkMid("nj", "installing")
    failOn = { op: "fixOwnership", times: 1 }
    const job = await run("cancel_install", "nj")
    expect(job).toMatchObject({ status: "failed", stage: "deleteDir" })
    await new Promise((r) => setTimeout(r, 10))
    await prisma.job.create({
      data: { midName: "nj", kind: "install", stage: "waitConnected", status: "failed", params: "{}", journalPath: join(dir, "x.journal"), createdBy: "admin1" },
    })
    failOn = null
    await eng.retryJob(admin, job.id)
    await eng.__idleForTests()
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe("failed")
    expect(readFileSync(after.journalPath, "utf8")).toContain("conflict")
    expect(existsSync(join(root, "mids", "nj", "agent", "config.xml"))).toBe(true)
  })

  it("ENOENT from spawning tar is internal (not not_found), fails the first attempt, retry skips", async () => {
    await mkMid("en")
    un.tarBin.path = "/nonexistent/tar"
    try {
      await expect(un.archiveMid("en")).rejects.toMatchObject({ code: "internal" })
      const job = await run("uninstall", "en")
      expect(job).toMatchObject({ status: "failed", stage: "archive" })
      await eng.retryJob(admin, job.id)
      await eng.__idleForTests()
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded")
    } finally {
      un.tarBin.path = "/usr/bin/tar"
    }
    expect(existsSync(join(root, "mids", "en"))).toBe(false)
    expect(archives()).toHaveLength(0)
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
  it("removes stale .partial files (>1 day) and keeps fresh ones", async () => {
    const a = join(root, "archive")
    mkdirSync(a, { recursive: true })
    writeFileSync(join(a, ".x-1.partial"), "x")
    writeFileSync(join(a, ".y-2.partial"), "x")
    const old = new Date(Date.now() - 2 * 86400_000)
    utimesSync(join(a, ".x-1.partial"), old, old)
    expect((await un.sweepArchives()).map((p) => p.split("/").pop())).toEqual([".x-1.partial"])
    expect(readdirSync(a)).toEqual([".y-2.partial"])
  })
  it("no archive dir -> []", async () => {
    expect(await un.sweepArchives()).toEqual([])
  })
})
