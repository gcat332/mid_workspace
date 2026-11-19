import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, unknown>
const db = vi.hoisted(() => ({ mids: [] as Row[], backups: [] as Row[], seq: 0, clock: 0 }))
const audit = vi.hoisted(() => vi.fn(async () => {}))
const helper = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
vi.mock("@/lib/helper/client", () => ({ callHelper: helper }))
vi.mock("@/lib/db/client", () => {
  const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => r[k] === v)
  const prisma = {
    midServer: {
      findUnique: async ({ where }: { where: Row }) => db.mids.find((r) => match(r, where)) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(db.mids.find((r) => match(r, where)) as Row, data),
    },
    configBackup: {
      create: async ({ data }: { data: Row }) => {
        const r = { id: `b${++db.seq}`, createdAt: new Date(++db.clock), ...data }
        db.backups.push(r)
        return r
      },
      findUnique: async ({ where }: { where: Row }) => db.backups.find((r) => match(r, where)) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        db.backups
          .filter((r) => match(r, where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .map((r) => ({ id: r.id, file: r.file, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt })),
      delete: async ({ where }: { where: Row }) => {
        db.backups.splice(db.backups.findIndex((r) => match(r, where)), 1)
      },
    },
  }
  return { prisma }
})

import { MidError } from "./names"
import { getBackup, hooks, listBackups, loadConfigFiles, rollback, saveConfigFile, saveForm } from "./config-service"

const user = { userId: "u1", email: "a@x.com", role: "member" as const, authAt: 0, ahAt: 0 }
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const XML = `<parameters>
  <parameter name="url" value="https://old.service-now.com/"/>
  <parameter name="name" value="mid-one"/>
  <parameter name="mid.instance.username" value="svc"/>
  <parameter name="mid.instance.password" secure="true" value="ENC(secret==)"/>
  <parameter name="mid.proxy.password" value="proxysecret"/>
</parameters>
`
const WRAP = "wrapper.java.maxmemory=1024\r\nwrapper.foo=bar\r\n"

let root: string
let xmlPath: string
let wrapPath: string
const rd = (p: string) => fs.readFileSync(p, "utf8")

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-cfg-"))
  process.env.MIDHUB_ROOT = root
  const d = path.join(root, "mids", "m1", "agent")
  fs.mkdirSync(path.join(d, "conf"), { recursive: true })
  xmlPath = path.join(d, "config.xml")
  wrapPath = path.join(d, "conf", "wrapper-override.conf")
  fs.writeFileSync(xmlPath, XML)
  fs.writeFileSync(wrapPath, WRAP)
  db.mids.length = 0
  db.backups.length = 0
  db.seq = 0
  db.mids.push({ id: "mid1", name: "m1", heapMb: 1024, state: "installed" }, { id: "mid2", name: "m2", heapMb: 1024, state: "installed" })
  audit.mockClear()
  helper.mockReset()
  helper.mockResolvedValue({ ok: true })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

describe("loadConfigFiles", () => {
  it("returns form values and hashes of the real content, never a real password", async () => {
    const r = await loadConfigFiles("m1")
    expect(r.files["config.xml"].hash).toBe(sha(XML))
    expect(r.files["wrapper-override.conf"].hash).toBe(sha(WRAP))
    expect(r.form).toMatchObject({ url: "https://old.service-now.com/", username: "svc", midName: "mid-one", heapMb: 1024, useProxy: false })
    const all = JSON.stringify(r)
    expect(all).not.toContain("ENC(secret==)")
    expect(all).not.toContain("proxysecret")
    expect(r.files["config.xml"].content).toContain('name="mid.instance.password" secure="true" value="********"')
    expect(r.files["config.xml"].content).toContain('name="mid.proxy.password" value="********"')
    expect(r.files["config.xml"].content).toContain('value="https://old.service-now.com/"')
  })
  it("tells the form whether passwords exist on disk, as booleans only (Q-M9)", async () => {
    const r = await loadConfigFiles("m1")
    expect(r.form).toMatchObject({ hasPassword: true, hasProxyPassword: true })
    fs.writeFileSync(xmlPath, XML.replace(/ENC\(secret==\)/, "").replace("proxysecret", ""))
    expect((await loadConfigFiles("m1")).form).toMatchObject({ hasPassword: false, hasProxyPassword: false })
  })
  it("a MID that is not registered is 404", async () => {
    await expect(loadConfigFiles("m9")).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("saveConfigFile", () => {
  it("stale baseHash -> 409, file unchanged, no backup", async () => {
    await expect(saveConfigFile("m1", "config.xml", XML.replace("old", "new"), "deadbeef", user)).rejects.toMatchObject({ code: "stale", status: 409 })
    expect(rd(xmlPath)).toBe(XML)
    expect(db.backups).toHaveLength(0)
  })
  it("raw save with a forbidden control char or char reference -> invalid_xml with the line", async () => {
    for (const bad of [XML.replace("old", "o\x01ld"), XML.replace("old", "o&#1;ld")]) {
      const err = await saveConfigFile("m1", "config.xml", bad, sha(XML), user).catch((e) => e)
      expect(err).toMatchObject({ code: "invalid_xml", status: 400 })
      expect(err.detail).toMatch(/^line \d+$/)
    }
    expect(rd(xmlPath)).toBe(XML)
  })
  it("invalid XML -> 400 with a Thai message + line number, parser text only in detail (Q-M3), file unchanged", async () => {
    const bad = XML.replace("</parameters>", "<oops>\n</parameters>")
    const err = await saveConfigFile("m1", "config.xml", bad, sha(XML), user).catch((e) => e)
    expect(err).toBeInstanceOf(MidError)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/ตรวจแท็กที่เปิด\/ปิดไม่ตรงกันรอบบรรทัด \d+/)
    expect(err.detail).toBeTruthy()
    expect(err.message).not.toContain(err.detail) // English parser text only behind the details toggle
    expect(rd(xmlPath)).toBe(XML)
    expect(db.backups).toHaveLength(0)
  })
  it("valid save stores the previous content as a backup (logical file name) and audits without content", async () => {
    const next = XML.replace("old", "new")
    await saveConfigFile("m1", "config.xml", next, sha(XML), user, "tweak")
    expect(rd(xmlPath)).toBe(next)
    expect(db.backups).toHaveLength(1)
    expect(db.backups[0]).toMatchObject({ midId: "mid1", file: "config.xml", content: XML, createdBy: "a@x.com" })
    expect(audit).toHaveBeenCalledWith(user, "config.save", "m1", { file: "config.xml", note: "tweak" })
    expect(JSON.stringify(audit.mock.calls)).not.toContain("secret")
  })
  it("keeps the on-disk password when the raw content still has ********", async () => {
    const raw = (await loadConfigFiles("m1")).files["config.xml"].content.replace("old", "new")
    await saveConfigFile("m1", "config.xml", raw, sha(XML), user)
    const disk = rd(xmlPath)
    expect(disk).toBe(XML.replace("old", "new"))
    expect(disk).not.toContain("********")
  })
  it("a changed password in raw content is written", async () => {
    await saveConfigFile("m1", "config.xml", XML.replace("ENC(secret==)", "plain"), sha(XML), user)
    expect(rd(xmlPath)).toContain('value="plain"')
  })
  it("heap change calls installUnit and updates MidServer.heapMb", async () => {
    await saveConfigFile("m1", "wrapper-override.conf", "wrapper.java.maxmemory=2048\r\nwrapper.foo=bar\r\n", sha(WRAP), user)
    expect(helper).toHaveBeenCalledWith({ op: "installUnit", name: "m1", heapMb: 2048 })
    expect(db.mids[0].heapMb).toBe(2048)
    expect(db.backups[0]).toMatchObject({ file: "wrapper-override.conf", content: WRAP })
  })
  it("no installUnit when heap is unchanged", async () => {
    await saveConfigFile("m1", "wrapper-override.conf", WRAP.replace("bar", "baz"), sha(WRAP), user)
    expect(helper).not.toHaveBeenCalled()
  })
  it("heap out of range or non-numeric -> 400, file unchanged", async () => {
    for (const v of ["100", "9000", "abc"]) {
      await expect(saveConfigFile("m1", "wrapper-override.conf", `wrapper.java.maxmemory=${v}\n`, sha(WRAP), user)).rejects.toMatchObject({ status: 400 })
    }
    expect(rd(wrapPath)).toBe(WRAP)
    expect(helper).not.toHaveBeenCalled()
  })
  it("installUnit failure: file stays saved, partial 502 with detail, save still audited", async () => {
    helper.mockRejectedValueOnce(new MidError("systemctl_failed", undefined, undefined, "boom"))
    const next = "wrapper.java.maxmemory=2048\r\n"
    const err = await saveConfigFile("m1", "wrapper-override.conf", next, sha(WRAP), user).catch((e) => e)
    expect(err).toMatchObject({ code: "partial", status: 502 })
    expect(err.message).toContain("บันทึกไฟล์แล้ว แต่ปรับ RAM ของ service ไม่สำเร็จ")
    expect(err.detail).toContain("boom")
    expect(rd(wrapPath)).toBe(next)
    expect(db.mids[0].heapMb).toBe(1024)
    expect(audit).toHaveBeenCalledWith(user, "config.save", "m1", expect.objectContaining({ file: "wrapper-override.conf" }))
  })
})

describe("partial retry", () => {
  it("saving the same heap again retries installUnit while the unit is behind the file", async () => {
    helper.mockRejectedValueOnce(new MidError("systemctl_failed", undefined, undefined, "boom"))
    const next = "wrapper.java.maxmemory=2048\r\n"
    await saveConfigFile("m1", "wrapper-override.conf", next, sha(WRAP), user).catch(() => {})
    await saveConfigFile("m1", "wrapper-override.conf", next, sha(next), user)
    expect(helper).toHaveBeenCalledTimes(2)
    expect(db.mids[0].heapMb).toBe(2048)
  })
})

describe("saveForm", () => {
  it("rejects XML-forbidden control chars in form values, file unchanged", async () => {
    const form = { url: "https://old.service-now.com/", username: "svc", midName: "mid-one", useProxy: false, proxyHost: "", proxyPort: "", proxyUser: "", heapMb: 1024, password: "pw\x01", proxyPassword: "" }
    const err = await saveForm("m1", form, sha(XML), sha(WRAP), user).catch((e) => e)
    expect(err).toMatchObject({ code: "invalid_request", detail: "field password" })
    expect(rd(xmlPath)).toBe(XML)
  })
  it("edits only the changed parameters; empty password means unchanged", async () => {
    const form = { url: "https://new.service-now.com/", username: "svc", midName: "mid-one", useProxy: false, proxyHost: "", proxyPort: "", proxyUser: "", heapMb: 1024, password: "", proxyPassword: "" }
    await saveForm("m1", form, sha(XML), sha(WRAP), user)
    expect(rd(xmlPath)).toBe(XML.replace("old", "new"))
    expect(rd(wrapPath)).toBe(WRAP)
    expect(helper).not.toHaveBeenCalled()
  })
  it("sets password and heap", async () => {
    const form = { url: "https://old.service-now.com/", username: "svc", midName: "mid-one", useProxy: true, proxyHost: "p.local", proxyPort: "8080", proxyUser: "", heapMb: 2048, password: "newpw", proxyPassword: "" }
    await saveForm("m1", form, sha(XML), sha(WRAP), user)
    const p = rd(xmlPath)
    expect(p).toContain('name="mid.instance.password" secure="true" value="newpw"')
    expect(p).toContain('name="mid.proxy.use_proxy" value="true"')
    expect(p).toContain('name="mid.proxy.host" value="p.local"')
    expect(rd(wrapPath)).toBe("wrapper.java.maxmemory=2048\r\nwrapper.foo=bar\r\n")
    expect(helper).toHaveBeenCalledWith({ op: "installUnit", name: "m1", heapMb: 2048 })
  })
  it("old wrapperBaseHash (heap changed elsewhere) -> 409, both files unchanged", async () => {
    const old = sha(WRAP)
    fs.writeFileSync(wrapPath, "wrapper.java.maxmemory=4096\r\n")
    const form = { url: "https://n/", username: "svc", midName: "x", useProxy: false, proxyHost: "", proxyPort: "", proxyUser: "", heapMb: 2048 }
    await expect(saveForm("m1", form, sha(XML), old, user)).rejects.toMatchObject({ code: "stale", status: 409 })
    expect(rd(xmlPath)).toBe(XML)
    expect(rd(wrapPath)).toBe("wrapper.java.maxmemory=4096\r\n")
    expect(db.backups).toHaveLength(0)
  })
  it("stale baseHash -> 409 and nothing written", async () => {
    const form = { url: "https://n/", username: "svc", midName: "x", useProxy: false, proxyHost: "", proxyPort: "", proxyUser: "", heapMb: 4096 }
    await expect(saveForm("m1", form, "nope", sha(WRAP), user)).rejects.toMatchObject({ code: "stale" })
    expect(rd(xmlPath)).toBe(XML)
    expect(rd(wrapPath)).toBe(WRAP)
  })
})

describe("mask resolution", () => {
  const raw = async () => (await loadConfigFiles("m1")).files["config.xml"].content
  it("a renamed secret parameter left as ******** is rejected, file unchanged", async () => {
    const r = (await raw()).replace('name="mid.instance.password"', 'name="mid.instance.passwd"')
    await expect(saveConfigFile("m1", "config.xml", r, sha(XML), user)).rejects.toMatchObject({ code: "mask_unresolved", status: 400 })
    expect(rd(xmlPath)).toBe(XML)
    expect(db.backups).toHaveLength(0)
  })
  it("a new foo.password = ******** is rejected", async () => {
    const r = (await raw()).replace("</parameters>", `  <parameter name="foo.password" value="********"/>\n</parameters>`)
    await expect(saveConfigFile("m1", "config.xml", r, sha(XML), user)).rejects.toMatchObject({ code: "mask_unresolved" })
    expect(rd(xmlPath)).toBe(XML)
  })
  it("a later duplicate with no on-disk counterpart is rejected", async () => {
    const r = (await raw()).replace("</parameters>", `  <parameter name="mid.instance.password" value="********"/>\n</parameters>`)
    await expect(saveConfigFile("m1", "config.xml", r, sha(XML), user)).rejects.toMatchObject({ code: "mask_unresolved" })
  })
  it("the normal masked save still keeps the on-disk value", async () => {
    await saveConfigFile("m1", "config.xml", (await raw()).replace("old", "new"), sha(XML), user)
    expect(rd(xmlPath)).toBe(XML.replace("old", "new"))
  })
})

describe("load warning and heap removal", () => {
  it("warns when config.xml on disk is malformed", async () => {
    fs.writeFileSync(xmlPath, XML + "<oops>")
    expect((await loadConfigFiles("m1")).warning).toMatch(/malformed/)
    fs.writeFileSync(xmlPath, XML)
    expect((await loadConfigFiles("m1")).warning).toBeUndefined()
  })
  it("removing the heap line does not call installUnit or touch heapMb", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await saveConfigFile("m1", "wrapper-override.conf", "wrapper.foo=bar\n", sha(WRAP), user)
    expect(helper).not.toHaveBeenCalled()
    expect(db.mids[0].heapMb).toBe(1024)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("backups and rollback", () => {
  it("lists newest first without content; get returns masked content", async () => {
    await saveConfigFile("m1", "config.xml", XML.replace("old", "v1"), sha(XML), user)
    const v1 = rd(xmlPath)
    await saveConfigFile("m1", "config.xml", v1.replace("v1", "v2"), sha(v1), user)
    const list = await listBackups("m1")
    expect(list.map((b) => b.id)).toEqual(["b2", "b1"])
    expect(JSON.stringify(list)).not.toContain("content")
    const b = await getBackup("m1", "b1")
    expect(b.content).toContain('value="********"')
    expect(b.content).not.toContain("ENC(secret==)")
    expect(b.content).not.toContain("proxysecret")
    expect(b.content).toContain("old.service-now.com")
  })
  it("rollback restores the backup and backs up the content it replaces", async () => {
    const next = XML.replace("old", "new")
    await saveConfigFile("m1", "config.xml", next, sha(XML), user)
    await rollback("m1", "b1", user)
    expect(rd(xmlPath)).toBe(XML)
    expect(db.backups).toHaveLength(2)
    expect(db.backups[1]).toMatchObject({ content: next, note: "rollback of b1" })
    expect(audit).toHaveBeenLastCalledWith(user, "config.rollback", "m1", { file: "config.xml", backupId: "b1" })
  })
  it("a backup of another MID is 404 for get and rollback", async () => {
    db.backups.push({ id: "bx", midId: "mid2", file: "config.xml", content: XML, note: "", createdBy: "a", createdAt: new Date() })
    await expect(getBackup("m1", "bx")).rejects.toMatchObject({ status: 404 })
    await expect(rollback("m1", "bx", user)).rejects.toMatchObject({ status: 404 })
    await expect(rollback("m1", "nope", user)).rejects.toMatchObject({ status: 404 })
    expect(rd(xmlPath)).toBe(XML)
  })
})

describe("TOCTOU: config files are read/written only through verified fds", () => {
  afterEach(() => { hooks.beforeIo = undefined })
  let outside: string
  beforeEach(() => {
    outside = path.join(root, "outside")
    fs.mkdirSync(path.join(outside, "conf"), { recursive: true })
    fs.writeFileSync(path.join(outside, "config.xml"), "SECRET_ENV=leak\n")
    fs.writeFileSync(path.join(outside, "conf", "wrapper-override.conf"), "APP_CODE\n")
  })
  const agent = () => path.join(root, "mids", "m1", "agent")
  /** After the path checks: the agent dir becomes a symlink to a directory outside the MID. */
  const swapAgentDir = () => {
    if (fs.lstatSync(agent()).isSymbolicLink()) return // loadConfigFiles opens both files: swap once
    fs.renameSync(agent(), agent() + ".old"); fs.symlinkSync(outside, agent())
  }

  it("load: config.xml replaced by a symlink after the check -> path_outside, nothing leaked", async () => {
    hooks.beforeIo = () => { fs.rmSync(xmlPath); fs.symlinkSync(path.join(outside, "config.xml"), xmlPath) }
    const r = await loadConfigFiles("m1").catch((e) => e)
    expect(r).toMatchObject({ code: "path_outside" })
    expect(JSON.stringify(r)).not.toContain("leak")
  })
  it("load: agent dir swapped for a symlink to outside -> path_outside", async () => {
    hooks.beforeIo = swapAgentDir
    await expect(loadConfigFiles("m1")).rejects.toMatchObject({ code: "path_outside" })
  })
  it("save: wrapper-override.conf swapped -> refused, outside file untouched, no backup", async () => {
    hooks.beforeIo = () => { fs.rmSync(wrapPath); fs.symlinkSync(path.join(outside, "conf", "wrapper-override.conf"), wrapPath) }
    await expect(saveConfigFile("m1", "wrapper-override.conf", "evil=1\n", sha(WRAP), user)).rejects.toMatchObject({ code: "path_outside" })
    expect(rd(path.join(outside, "conf", "wrapper-override.conf"))).toBe("APP_CODE\n")
    expect(db.backups).toHaveLength(0)
  })
  it("save: agent dir swapped -> refused, outside config untouched", async () => {
    hooks.beforeIo = swapAgentDir
    await expect(saveConfigFile("m1", "config.xml", XML.replace("old", "new"), sha(XML), user)).rejects.toMatchObject({ code: "path_outside" })
    expect(rd(path.join(outside, "config.xml"))).toBe("SECRET_ENV=leak\n")
  })
  it("rollback: target swapped -> refused, outside untouched", async () => {
    await saveConfigFile("m1", "config.xml", XML.replace("old", "new"), sha(XML), user)
    hooks.beforeIo = swapAgentDir
    await expect(rollback("m1", "b1", user)).rejects.toMatchObject({ code: "path_outside" })
    expect(rd(path.join(outside, "config.xml"))).toBe("SECRET_ENV=leak\n")
  })
  it("a missing wrapper-override.conf is still created (0664) on first save", async () => {
    fs.rmSync(wrapPath)
    expect((await loadConfigFiles("m1")).files["wrapper-override.conf"]).toEqual({ content: "", hash: sha("") })
    await saveConfigFile("m1", "wrapper-override.conf", "wrapper.foo=1\n", sha(""), user)
    expect(rd(wrapPath)).toBe("wrapper.foo=1\n")
    expect(fs.statSync(wrapPath).mode & 0o777).toBe(0o664)
  })
  it("keeps the inode (in-place write through the verified fd)", async () => {
    const ino = fs.statSync(xmlPath).ino
    await saveConfigFile("m1", "config.xml", XML.replace("old", "new"), sha(XML), user)
    expect(fs.statSync(xmlPath).ino).toBe(ino)
  })
})
