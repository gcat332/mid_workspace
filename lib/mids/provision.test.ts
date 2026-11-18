import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

  it("never leaks the passwords in errors", async () => {
    fs.writeFileSync(path.join(mid("new1"), "agent/config.xml"), "<parameters><parameter name='url' value='x'")
    const e = await configureMid("new1", { ...INPUT, proxy: { host: "h", port: 1, password: "PROXYSECRET" } }).then(() => new Error("no throw"), (x: Error) => x)
    expect(JSON.stringify([e.message, (e as { detail?: string }).detail])).not.toMatch(/PROXYSECRET|S3cr/)
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

  it("does not follow a symlinked extlib dir in src", async () => {
    fs.rmSync(path.join(mid("src1"), "agent/extlib"), { recursive: true })
    fs.mkdirSync(path.join(root, "elsewhere"))
    fs.writeFileSync(path.join(root, "elsewhere/x.jar"), "X")
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(mid("src1"), "agent/extlib"))
    await expect(cloneFiles("src1", "new1")).rejects.toMatchObject({ code: "path_outside" })
    expect(fs.existsSync(path.join(mid("new1"), "agent/extlib/x.jar"))).toBe(false)
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
