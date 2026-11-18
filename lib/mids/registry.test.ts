import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, unknown>
const db = vi.hoisted(() => ({ mids: [] as Row[], instances: [] as Row[], seq: 0 }))
const audit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
vi.mock("@/lib/db/client", () => {
  const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "not" in v ? r[k] !== (v as Row).not : r[k] === v))
  const table = (rows: () => Row[]) => ({
    findUnique: async ({ where }: { where: Row }) => rows().find((r) => match(r, where)) ?? null,
    findMany: async ({ where = {}, orderBy }: { where?: Row; orderBy?: { name: "asc" } } = {}) => {
      const out = rows().filter((r) => match(r, where))
      return orderBy ? out.sort((a, b) => String(a.name).localeCompare(String(b.name))) : out
    },
    create: async ({ data }: { data: Row }) => {
      const r = { id: `id${++db.seq}`, version: null, removedAt: null, ...data }
      rows().push(r)
      return r
    },
    update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(rows().find((r) => match(r, where)) as Row, data),
  })
  return { prisma: { midServer: table(() => db.mids), instance: table(() => db.instances) } }
})

import { MidError } from "./names"
import { deps, getMid, importMid, listMids } from "./registry"

const user = { userId: "u1", email: "a@x.com", role: "member" as const, authAt: 0 }
const CFG = (url: string, name: string) =>
  `<parameters>\n<parameter name="url" value="${url}"/>\n<parameter name="name" value="${name}"/>\n</parameters>\n`
const status = { state: "running" as const, pid: 1, memoryBytes: 10, since: null }

let root: string
const mkMid = (n: string, cfg?: string, wrapper?: string) => {
  const d = path.join(root, "mids", n, "agent")
  fs.mkdirSync(path.join(d, "conf"), { recursive: true })
  if (cfg !== undefined) fs.writeFileSync(path.join(d, "config.xml"), cfg)
  if (wrapper !== undefined) fs.writeFileSync(path.join(d, "conf", "wrapper-override.conf"), wrapper)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-reg-"))
  process.env.MIDHUB_ROOT = root
  db.mids.length = 0
  db.instances.length = 0
  audit.mockClear()
  deps.unitLoaded = async () => true
  deps.readStatus = async () => status
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

describe("importMid", () => {
  it("rejects a folder without config.xml (not_a_mid) and a missing folder", async () => {
    mkMid("nocfg")
    await expect(importMid("nocfg", user)).rejects.toMatchObject({ code: "not_a_mid" })
    await expect(importMid("ghost", user)).rejects.toMatchObject({ code: "not_a_mid" })
  })
  it("rejects when the systemd unit is missing (not_found)", async () => {
    mkMid("m1", CFG("https://a.service-now.com/", "M1"))
    deps.unitLoaded = async () => false
    await expect(importMid("m1", user)).rejects.toMatchObject({ code: "not_found", status: 404 })
    expect(db.mids).toHaveLength(0)
  })
  it("rejects an invalid name", async () => {
    await expect(importMid("Bad Name", user)).rejects.toMatchObject({ code: "invalid_name" })
  })
  it("creates the MidServer and Instance, audits, returns a summary", async () => {
    mkMid("m1", CFG("https://A.service-now.com/", "SN-MID-1"), "wrapper.java.maxmemory=2048\n")
    const s = await importMid("m1", user)
    expect(s).toMatchObject({ name: "m1", midName: "SN-MID-1", instanceUrl: "https://a.service-now.com", heapMb: 2048, state: "installed", status })
    expect(db.mids[0]).toMatchObject({ dir: path.join(root, "mids", "m1"), serviceName: "midhub-mid-m1.service", createdBy: "a@x.com" })
    expect(db.instances).toHaveLength(1)
    expect(db.instances[0]).toMatchObject({ url: "https://a.service-now.com", label: "a.service-now.com", createdBy: "a@x.com" })
    expect(audit).toHaveBeenCalledWith(user, "mid.import", "m1", expect.any(Object))
  })
  it("defaults heap to 1024 and links an existing Instance by normalized url", async () => {
    db.instances.push({ id: "inst", url: "https://a.service-now.com", label: "x" })
    mkMid("m1", CFG("https://a.service-now.com/", "N"))
    await importMid("m1", user)
    expect(db.mids[0]).toMatchObject({ heapMb: 1024, instanceId: "inst" })
    expect(db.instances).toHaveLength(1)
  })
  it("importing twice is a 409 conflict", async () => {
    mkMid("m1", CFG("https://a.service-now.com/", "N"))
    await importMid("m1", user)
    await expect(importMid("m1", user)).rejects.toMatchObject({ code: "conflict", status: 409 })
  })
  it("revives a removed row", async () => {
    mkMid("m1", CFG("https://a.service-now.com/", "N"))
    db.mids.push({ id: "old", name: "m1", state: "removed", removedAt: new Date(), heapMb: 512, createdBy: "z", dir: "", serviceName: "" })
    const s = await importMid("m1", user)
    expect(db.mids).toHaveLength(1)
    expect(s.state).toBe("installed")
    expect(db.mids[0].removedAt).toBeNull()
  })
})

describe("listMids / getMid", () => {
  it("merges rows with status, sorts by name, hides removed, tolerates unreadable config", async () => {
    mkMid("bb", CFG("https://a.service-now.com/", "BB"))
    mkMid("aa") // no config.xml
    db.mids.push(
      { id: "1", name: "bb", state: "installed", heapMb: 1024, version: "v1", instanceId: null },
      { id: "2", name: "aa", state: "installed", heapMb: 512, version: null, instanceId: null },
      { id: "3", name: "gone", state: "removed", heapMb: 1024, version: null, instanceId: null },
    )
    const list = await listMids()
    expect(list.map((m) => m.name)).toEqual(["aa", "bb"])
    expect(list[0]).toMatchObject({ midName: null, instanceUrl: null, heapMb: 512, status })
    expect(list[1]).toMatchObject({ midName: "BB", instanceUrl: "https://a.service-now.com", version: "v1" })
  })
  it("falls back to unknown status when status read fails; Instance.url wins", async () => {
    mkMid("bb", CFG("https://cfg.service-now.com/", "BB"))
    db.instances.push({ id: "i", url: "https://inst.service-now.com" })
    db.mids.push({ id: "1", name: "bb", state: "installed", heapMb: 1024, version: null, instanceId: "i" })
    deps.readStatus = async () => {
      throw new Error("x")
    }
    const [m] = await listMids()
    expect(m.status).toEqual({ state: "unknown", pid: null, memoryBytes: null, since: null })
    expect(m.instanceUrl).toBe("https://inst.service-now.com")
  })
  it("getMid: 404 for unknown or removed", async () => {
    db.mids.push({ id: "3", name: "gone", state: "removed", heapMb: 1024, version: null, instanceId: null })
    await expect(getMid("nope")).rejects.toBeInstanceOf(MidError)
    await expect(getMid("gone")).rejects.toMatchObject({ code: "not_found" })
  })
})
