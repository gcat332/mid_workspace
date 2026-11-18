import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readParams, validateXml } from "./config-xml"
import { readProp } from "./java-props"
import { CLONE_MAX_FILES, cloneFiles, configureMid, type ProvisionInput } from "./provision"

const TEMPLATE = fs.readFileSync(path.join(__dirname, "test-fixtures/config.template.xml"), "utf8")
const GLIDE = "mid.buildstamp=2026-10-13-1248\ncom.service_now.mid.logging.MIDLogFileHandler.count=10\ncom.service_now.mid.logging.SecurityLogFileHandler.count=10\nother.key=keep\n"
const WRAP = "wrapper.name=mid\n#wrapper.java.maxmemory=1024\n"
const INPUT: ProvisionInput = { url: "https://acme.service-now.com", midUser: "mid_user", password: "S3cr&t<pw>", snName: "acme-mid", heapMb: 2048, logFiles: 3 }

let root: string
const mid = (n: string) => path.join(root, "mids", n)
const rd = (n: string, rel: string) => fs.readFileSync(path.join(mid(n), rel), "utf8")

function makeMid(n: string, glide = true) {
  for (const d of ["agent/conf", "agent/extlib", "agent/properties"]) fs.mkdirSync(path.join(mid(n), d), { recursive: true })
  fs.writeFileSync(path.join(mid(n), "agent/config.xml"), TEMPLATE)
  fs.writeFileSync(path.join(mid(n), "agent/conf/wrapper-override.conf"), WRAP)
  if (glide) fs.writeFileSync(path.join(mid(n), "agent/properties/glide.properties"), GLIDE)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-prov-"))
  process.env.MIDHUB_ROOT = root
  makeMid("new1")
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

describe("configureMid", () => {
  it("sets the 4 values and touches only those lines", async () => {
    expect(await configureMid("new1", INPUT)).toEqual({ warnings: [] })
    const xml = rd("new1", "agent/config.xml")
    const p = readParams(xml)
    expect(p).toMatchObject({ url: INPUT.url, "mid.instance.username": "mid_user", "mid.instance.password": INPUT.password, name: "acme-mid", mid_sys_id: "" })
    expect(p["mid.custom.setting"]).toBe("keep-me")
    const a = TEMPLATE.split("\n")
    const b = xml.split("\n")
    expect(b.length).toBe(a.length)
    expect(b.flatMap((l, i) => (l === a[i] ? [] : [i])).length).toBe(4)
    expect(xml).toContain('secure="true"')
    expect(validateXml(xml).ok).toBe(true)
  })

  it("proxy case appends mid.proxy.* elements, valid XML", async () => {
    await configureMid("new1", { ...INPUT, proxy: { host: "proxy.local", port: 3128, user: "pu", password: "pp" } })
    const xml = rd("new1", "agent/config.xml")
    expect(validateXml(xml).ok).toBe(true)
    expect(readParams(xml)).toMatchObject({
      "mid.proxy.use_proxy": "true", "mid.proxy.host": "proxy.local", "mid.proxy.port": "3128", "mid.proxy.username": "pu", "mid.proxy.password": "pp",
    })
  })

  it("writes wrapper and glide settings, other glide lines unchanged", async () => {
    await configureMid("new1", INPUT)
    const w = rd("new1", "agent/conf/wrapper-override.conf")
    expect(w).toContain("wrapper.java.maxmemory=2048")
    expect(w).toContain("wrapper.logfile.maxfiles=3")
    const g = rd("new1", "agent/properties/glide.properties")
    expect(readProp(g, "com.service_now.mid.logging.MIDLogFileHandler.count")).toBe("3")
    expect(readProp(g, "com.service_now.mid.logging.SecurityLogFileHandler.count")).toBe("3")
    expect(g.split("\n").filter((l) => !l.includes(".count="))).toEqual(GLIDE.split("\n").filter((l) => !l.includes(".count=")))
  })

  it("is idempotent", async () => {
    await configureMid("new1", INPUT)
    const snap = ["config.xml", "conf/wrapper-override.conf", "properties/glide.properties"].map((f) => rd("new1", "agent/" + f))
    await configureMid("new1", INPUT)
    expect(["config.xml", "conf/wrapper-override.conf", "properties/glide.properties"].map((f) => rd("new1", "agent/" + f))).toEqual(snap)
  })

  it("rejects bad logFiles / heap with invalid_request and writes nothing", async () => {
    await expect(configureMid("new1", { ...INPUT, logFiles: 11 })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(configureMid("new1", { ...INPUT, logFiles: 0 })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(configureMid("new1", { ...INPUT, heapMb: 100 })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(configureMid("new1", { ...INPUT, heapMb: 9000 })).rejects.toMatchObject({ code: "invalid_request" })
    expect(rd("new1", "agent/config.xml")).toBe(TEMPLATE)
  })

  it("warns and skips when glide.properties is missing; never creates it", async () => {
    fs.rmSync(path.join(mid("new1"), "agent/properties/glide.properties"))
    const r = await configureMid("new1", INPUT)
    expect(r.warnings).toHaveLength(1)
    expect(fs.existsSync(path.join(mid("new1"), "agent/properties/glide.properties"))).toBe(false)
    expect(rd("new1", "agent/conf/wrapper-override.conf")).toContain("maxfiles=3")
  })

  it("creates a missing wrapper-override.conf", async () => {
    fs.rmSync(path.join(mid("new1"), "agent/conf/wrapper-override.conf"))
    await configureMid("new1", INPUT)
    expect(rd("new1", "agent/conf/wrapper-override.conf")).toContain("wrapper.java.maxmemory=2048")
  })

  it("does not follow a symlinked config.xml out of the MID", async () => {
    const outside = path.join(root, "outside.xml")
    fs.writeFileSync(outside, TEMPLATE)
    const cfg = path.join(mid("new1"), "agent/config.xml")
    fs.rmSync(cfg)
    fs.symlinkSync(outside, cfg)
    await expect(configureMid("new1", INPUT)).rejects.toMatchObject({ code: "path_outside" })
    expect(fs.readFileSync(outside, "utf8")).toBe(TEMPLATE)
  })

  it("second proxy run gives identical bytes", async () => {
    const i = { ...INPUT, proxy: { host: "proxy.local", port: 3128, user: "pu", password: "pp" } }
    await configureMid("new1", i)
    const a = rd("new1", "agent/config.xml")
    await configureMid("new1", i)
    expect(rd("new1", "agent/config.xml")).toBe(a)
  })

  it("attacker values stay inside their attribute", async () => {
    const evil = 'a"/><parameter name="x" value="y\n]]>--><!--\x01\x7f'
    const r = await configureMid("new1", { ...INPUT, snName: evil, password: evil }).then(() => null, (e: Error) => e)
    expect(r).toBeNull()
    const p = readParams(rd("new1", "agent/config.xml"))
    expect(p.name).toBe(evil)
    expect(p.x).toBeUndefined()
  })

  it("invalid_xml error (registered, 400) carries only the line, never values", async () => {
    const bad = '<parameters>\n<parameter name="url" value="x"/>\n<oops>\n</parameters>\n'
    fs.writeFileSync(path.join(mid("new1"), "agent/config.xml"), bad)
    const e = await configureMid("new1", { ...INPUT, password: "PWSECRET", proxy: { host: "h", port: 1, password: "PROXYSECRET" } }).then(
      () => new Error("no throw"),
      (x: Error) => x,
    )
    expect(e).toMatchObject({ code: "invalid_xml", status: 400 })
    expect(e.message).toMatch(/บรรทัด \d+/)
    expect(JSON.stringify([e.message, (e as { detail?: string }).detail])).not.toMatch(/PROXYSECRET|PWSECRET/)
    expect(rd("new1", "agent/config.xml")).toBe(bad)
  })
})

describe("cloneFiles", () => {
  beforeEach(() => {
    makeMid("src1")
    fs.writeFileSync(path.join(mid("src1"), "agent/config.xml"), TEMPLATE.replace('name="mid_sys_id" value=""', 'name="mid_sys_id" value="abc123"'))
    fs.writeFileSync(path.join(mid("src1"), "agent/conf/wrapper-override.conf"), WRAP + "wrapper.custom=1\n")
    fs.mkdirSync(path.join(mid("src1"), "agent/extlib/sub"))
    fs.writeFileSync(path.join(mid("src1"), "agent/extlib/a.jar"), "JAR")
    fs.writeFileSync(path.join(mid("src1"), "agent/extlib/sub/run.sh"), "#!/bin/sh")
    fs.chmodSync(path.join(mid("src1"), "agent/extlib/sub/run.sh"), 0o755)
    fs.symlinkSync("/etc/passwd", path.join(mid("src1"), "agent/extlib/evil.jar"))
    fs.mkdirSync(path.join(mid("src1"), "agent/security"))
    fs.writeFileSync(path.join(mid("src1"), "agent/security/agent_keystore"), "KEY")
  })

  it("copies config, wrapper and extlib; clears mid_sys_id; skips symlinks; leaves security alone", async () => {
    const r = await cloneFiles("src1", "new1")
    expect(r.skipped).toEqual(["agent/extlib/evil.jar (symlink)"])
    const p = readParams(rd("new1", "agent/config.xml"))
    expect(p.mid_sys_id).toBe("")
    expect(p["mid.custom.setting"]).toBe("keep-me")
    expect(rd("new1", "agent/conf/wrapper-override.conf")).toContain("wrapper.custom=1")
    expect(rd("new1", "agent/extlib/a.jar")).toBe("JAR")
    expect(fs.statSync(path.join(mid("new1"), "agent/extlib/a.jar")).mode & 0o777).toBe(0o664)
    expect(fs.statSync(path.join(mid("new1"), "agent/extlib/sub/run.sh")).mode & 0o777).toBe(0o775)
    expect(fs.existsSync(path.join(mid("new1"), "agent/extlib/evil.jar"))).toBe(false)
    expect(fs.existsSync(path.join(mid("new1"), "agent/security"))).toBe(false)
  })

  it("skips (never follows) a symlinked extlib dir in src", async () => {
    fs.rmSync(path.join(mid("src1"), "agent/extlib"), { recursive: true })
    fs.mkdirSync(path.join(root, "elsewhere"))
    fs.writeFileSync(path.join(root, "elsewhere/x.jar"), "X")
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(mid("src1"), "agent/extlib"))
    const r = await cloneFiles("src1", "new1")
    expect(r.skipped).toEqual(["agent/extlib (symlink)"])
    expect(fs.existsSync(path.join(mid("new1"), "agent/extlib/x.jar"))).toBe(false)
  })

  it("skips a symlinked config.xml and wrapper-override.conf in src", async () => {
    fs.writeFileSync(path.join(root, "o.txt"), "OUT")
    for (const f of ["agent/config.xml", "agent/conf/wrapper-override.conf"]) {
      fs.rmSync(path.join(mid("src1"), f))
      fs.symlinkSync(path.join(root, "o.txt"), path.join(mid("src1"), f))
    }
    const r = await cloneFiles("src1", "new1")
    expect(r.skipped).toEqual(expect.arrayContaining(["agent/config.xml (symlink)", "agent/conf/wrapper-override.conf (symlink)"]))
    expect(rd("new1", "agent/config.xml")).toBe(TEMPLATE)
    expect(rd("new1", "agent/conf/wrapper-override.conf")).toBe(WRAP)
  })

  it("clears encrypted/secure values and warns by name", async () => {
    const xml = TEMPLATE.replace('<parameter name="mid.log.level" value="info"/>', '<parameter name="mid.log.level" value="info"/>\n  <parameter name="mid.proxy.password" value="ENCv2[abc]"/>\n  <parameter name="tok" encrypt="true" value="zzz"/>')
    fs.writeFileSync(path.join(mid("src1"), "agent/config.xml"), xml)
    const r = await cloneFiles("src1", "new1")
    const p = readParams(rd("new1", "agent/config.xml"))
    expect(p["mid.instance.password"]).toBe("")
    expect(p["mid.proxy.password"]).toBe("")
    expect(p.tok).toBe("")
    expect(p["mid.custom.setting"]).toBe("keep-me")
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/mid\.proxy\.password/)
    expect(r.warnings[0]).not.toMatch(/YOUR_PASSWORD|ENCv2|zzz/)
  })

  it("skips hardlinks, FIFOs and nested symlinked dirs; sanitises names", async () => {
    const ext = path.join(mid("src1"), "agent/extlib")
    fs.linkSync(path.join(ext, "a.jar"), path.join(ext, "hard.jar"))
    execFileSync("/usr/bin/mkfifo", [path.join(ext, "pipe")])
    fs.mkdirSync(path.join(ext, "sub2"))
    fs.symlinkSync(path.join(root, ".."), path.join(ext, "sub2/up"))
    fs.symlinkSync("/etc", path.join(ext, "bad\x01name"))
    const r = await cloneFiles("src1", "new1")
    expect(r.skipped).toEqual(expect.arrayContaining([
      "agent/extlib/a.jar (hardlink)", "agent/extlib/hard.jar (hardlink)", "agent/extlib/pipe (not a regular file)",
      "agent/extlib/sub2/up (symlink)", "agent/extlib/bad?name (symlink)",
    ]))
    expect(fs.existsSync(path.join(mid("new1"), "agent/extlib/pipe"))).toBe(false)
  })

  it("caps skipped at 100 plus a summary line", async () => {
    for (let i = 0; i < 130; i++) fs.symlinkSync("/etc", path.join(mid("src1"), `agent/extlib/l${i}`))
    const r = await cloneFiles("src1", "new1")
    expect(r.skipped).toHaveLength(101)
    expect(r.skipped[100]).toMatch(/^…และอีก 31 รายการ$/)
  })

  it("rejects extlib nested deeper than 32", async () => {
    let p = path.join(mid("src1"), "agent/extlib")
    for (let i = 0; i < 35; i++) p = path.join(p, "d")
    fs.mkdirSync(p, { recursive: true })
    await expect(cloneFiles("src1", "new1")).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("counts directories toward the entry cap", async () => {
    for (let i = 0; i <= CLONE_MAX_FILES; i++) fs.mkdirSync(path.join(mid("src1"), `agent/extlib/d${i}`))
    await expect(cloneFiles("src1", "new1")).rejects.toMatchObject({ code: "invalid_request" })
  }, 60_000)

  it("stops when aborted and leaves no temp files", async () => {
    const ac = new AbortController()
    ac.abort(new Error("stop"))
    await expect(cloneFiles("src1", "new1", ac.signal)).rejects.toThrow("stop")
    expect(fs.readdirSync(path.join(mid("new1"), "agent")).filter((n) => n.includes(".midhub-"))).toEqual([])
  })

  it("writes atomically: no temp files left behind", async () => {
    await cloneFiles("src1", "new1")
    for (const d of ["agent", "agent/conf", "agent/extlib"]) expect(fs.readdirSync(path.join(mid("new1"), d)).filter((n) => n.includes(".midhub-"))).toEqual([])
  })

  it("rejects when extlib exceeds the file-count cap", async () => {
    for (let i = 0; i < CLONE_MAX_FILES; i++) fs.writeFileSync(path.join(mid("src1"), `agent/extlib/f${i}`), "")
    await expect(cloneFiles("src1", "new1")).rejects.toMatchObject({ code: "invalid_request" })
  }, 60_000)

  it("rejects when extlib exceeds the byte cap (sparse file)", async () => {
    fs.truncateSync(path.join(mid("src1"), "agent/extlib/a.jar"), 501 * 1024 ** 2)
    await expect(cloneFiles("src1", "new1")).rejects.toMatchObject({ code: "invalid_request" })
  })
})
