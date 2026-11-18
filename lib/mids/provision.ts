// Writes a freshly extracted MID's config (config.xml, wrapper-override.conf, glide.properties) and copies the
// selected files from another MID (clone). Every file access under mids/ goes through safe-fs handles with a
// real-path check against the MID root (same approach as config-service.ts, whose helpers are DB/audit-coupled and
// private). Secrets (password, proxy password) are never logged or put into errors.
import path from "node:path"
import fs from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { MAX_HEAP_MB, MIN_HEAP_MB } from "@/lib/helper/protocol"
import { readParamAttrs, setParams, validateXml } from "./config-xml"
import { setProp } from "./java-props"
import { CONFIG_XML, GLIDE_PROPERTIES, LOG_COUNT_KEYS, MAX_LOG_FILES, MIN_LOG_FILES, WRAPPER_OVERRIDE } from "./layout"
import { atomicWrite, isEnoent, readOpt, target, writeFileAt } from "./mid-files"
import { MidError } from "./names"
import { resolveMidPath } from "./paths"
import { fdPath, insideCheck, lstatIn, mkdirIn, openDir, openFile, translateFsError, type Check } from "./safe-fs"
import { setHeapMb } from "./wrapper-conf"

export type ProvisionInput = {
  url: string
  midUser: string
  password: string
  /** The MID's name in ServiceNow (config.xml `name`). */
  snName: string
  heapMb: number
  logFiles: number
  proxy?: { host: string; port: number; user?: string; password?: string }
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
export const CLONE_MAX_BYTES = 500 * 1024 ** 2
export const CLONE_MAX_FILES = 5000
const MAX_DEPTH = 32
const MAX_SKIPPED = 100
const CHUNK = 1024 * 1024
const EXTLIB = "agent/extlib"

const bad = (detail: string): MidError => new MidError("invalid_request", undefined, undefined, detail)
const capError = (detail: string): MidError =>
  new MidError("invalid_request", undefined, "extlib ของ MID ต้นทางใหญ่เกิน 500 MB หรือมีไฟล์เกิน 5000 ไฟล์ จึงโคลนไม่ได้", detail)
const xmlError = (line: number): MidError =>
  new MidError("invalid_xml", 400, `config.xml ที่ได้ไม่ถูกต้อง (บรรทัด ${line}) — ตรวจค่าที่กรอกแล้วลองใหม่`, `line ${line}`)

function validateInput(i: ProvisionInput): void {
  if (!i || typeof i !== "object") throw bad("input")
  for (const [k, v] of [["url", i.url], ["midUser", i.midUser], ["password", i.password], ["snName", i.snName]] as const) {
    if (typeof v !== "string" || (k !== "password" && v === "") || /\0/.test(v)) throw bad(`field ${k}`)
  }
  if (!Number.isInteger(i.logFiles) || i.logFiles < MIN_LOG_FILES || i.logFiles > MAX_LOG_FILES) {
    throw new MidError("invalid_request", undefined, `จำนวนไฟล์ log ต้องอยู่ระหว่าง ${MIN_LOG_FILES}-${MAX_LOG_FILES}`, "logFiles")
  }
  if (!Number.isInteger(i.heapMb) || i.heapMb < MIN_HEAP_MB || i.heapMb > MAX_HEAP_MB) {
    throw new MidError("invalid_request", undefined, `RAM (heap) ต้องเป็นจำนวนเต็ม ${MIN_HEAP_MB}-${MAX_HEAP_MB} MB`, "heapMb")
  }
  const p = i.proxy
  if (p !== undefined) {
    if (typeof p !== "object" || p === null || typeof p.host !== "string" || p.host === "") throw bad("proxy.host")
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw bad("proxy.port")
    for (const [k, v] of [["user", p.user], ["password", p.password]] as const) {
      if (v !== undefined && typeof v !== "string") throw bad(`proxy.${k}`)
    }
  }
}

/** Idempotent: same input -> same bytes. Returns warnings (e.g. glide.properties missing). */
export async function configureMid(name: string, input: ProvisionInput): Promise<{ warnings: string[] }> {
  validateInput(input)
  const warnings: string[] = []
  const [xmlT, wrapT, glideT] = await Promise.all([target(name, CONFIG_XML), target(name, WRAPPER_OVERRIDE), target(name, GLIDE_PROPERTIES)])

  const xml = await readOpt(xmlT, MAX_FILE_BYTES)
  if (xml === null) throw new MidError("not_found")
  const params: Record<string, string> = {
    url: input.url,
    "mid.instance.username": input.midUser,
    "mid.instance.password": input.password,
    name: input.snName,
  }
  if (input.proxy) {
    const p = input.proxy
    params["mid.proxy.use_proxy"] = "true"
    params["mid.proxy.host"] = p.host
    params["mid.proxy.port"] = String(p.port)
    if (p.user) params["mid.proxy.username"] = p.user
    if (p.password) params["mid.proxy.password"] = p.password
  }
  const nextXml = setParams(xml, params)
  const v = validateXml(nextXml)
  if (!v.ok) throw xmlError(v.line) // the parser message is omitted: it may quote values

  const wrap = (await readOpt(wrapT, MAX_FILE_BYTES)) ?? ""
  const nextWrap = setProp(setHeapMb(wrap, input.heapMb), LOG_COUNT_KEYS.wrapper, String(input.logFiles))

  const glide = await readOpt(glideT, MAX_FILE_BYTES)
  let nextGlide: string | null = null
  if (glide === null) warnings.push("ไม่พบ agent/properties/glide.properties จึงไม่ได้ตั้งจำนวนไฟล์ log ของ MID/security")
  else nextGlide = setProp(setProp(glide, LOG_COUNT_KEYS.mid, String(input.logFiles)), LOG_COUNT_KEYS.security, String(input.logFiles))

  if (nextXml !== xml) await writeFileAt(xmlT, Buffer.from(nextXml, "utf8"))
  if (nextWrap !== wrap) await writeFileAt(wrapT, Buffer.from(nextWrap, "utf8"))
  if (nextGlide !== null && nextGlide !== glide) await writeFileAt(glideT, Buffer.from(nextGlide, "utf8"))
  return { warnings }
}

type CloneState = {
  entries: number
  bytes: number
  skipped: string[]
  skippedExtra: number
  srcCheck: Check
  dstCheck: Check
  signal?: AbortSignal
}

const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200)
function skip(s: CloneState, rel: string, why: string): void {
  if (s.skipped.length < MAX_SKIPPED) s.skipped.push(cleanName(`${rel} (${why})`))
  else s.skippedExtra++
}
const whyNot = (st: fs.Stats): string => (st.isSymbolicLink() ? "symlink" : "not a regular file")

/** Creates `<parent>/<name>` (2775) under the verified parent directory when missing. */
async function ensureDir(parent: string, name: string, check: Check): Promise<void> {
  const p = await openDir(parent, check)
  try {
    if (!(await lstatIn(p, name))) await mkdirIn(p, parent, name, check)
  } finally {
    await p.close()
  }
}

async function writeAll(w: FileHandle, buf: Buffer): Promise<void> {
  for (let off = 0; off < buf.length; ) off += (await w.write(buf, off, buf.length - off)).bytesWritten
}

async function copyFile(s: CloneState, srcDir: FileHandle, srcAbs: string, dstAbs: string, rel: string): Promise<void> {
  const { h, st } = await openFile(srcAbs, "r", s.srcCheck, fdPath(srcDir, path.basename(srcAbs)))
  try {
    if (st.nlink !== 1) return skip(s, rel, "hardlink")
    if (s.bytes + st.size > CLONE_MAX_BYTES) throw capError(`bytes>${CLONE_MAX_BYTES}`)
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(st.size, 1)))
    await atomicWrite(
      { abs: dstAbs, check: s.dstCheck },
      async (w) => {
        for (let pos = 0; ; ) {
          s.signal?.throwIfAborted()
          const { bytesRead } = await h.read(buf, 0, buf.length, pos)
          if (bytesRead === 0) break
          s.bytes += bytesRead // actual bytes: a file that grew after fstat still counts
          if (s.bytes > CLONE_MAX_BYTES) throw capError(`bytes>${CLONE_MAX_BYTES}`)
          await writeAll(w, buf.subarray(0, bytesRead))
          pos += bytesRead
        }
      },
      st.mode & 0o111 ? 0o775 : 0o664,
    )
  } finally {
    await h.close()
  }
}

async function copyDir(s: CloneState, srcAbs: string, dstAbs: string, rel: string, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) throw capError(`depth>${MAX_DEPTH}`)
  const d = await openDir(srcAbs, s.srcCheck)
  try {
    let inDir = 0
    for await (const ent of await fs.promises.opendir(fdPath(d))) {
      s.signal?.throwIfAborted()
      if (++inDir > CLONE_MAX_FILES || ++s.entries > CLONE_MAX_FILES) throw capError(`entries>${CLONE_MAX_FILES}`)
      const n = ent.name
      const r = `${rel}/${n}`
      const st = await lstatIn(d, n)
      if (!st) continue
      if (st.isDirectory()) {
        await ensureDir(dstAbs, n, s.dstCheck)
        await copyDir(s, path.join(srcAbs, n), path.join(dstAbs, n), r, depth + 1)
      } else if (st.isFile()) {
        await copyFile(s, d, path.join(srcAbs, n), path.join(dstAbs, n), r)
      } else {
        skip(s, r, whyNot(st))
      }
    }
  } finally {
    await d.close()
  }
}

/** Reads a regular file of an (untrusted) src dir; symlinks/special files are skipped and reported, never followed. */
async function srcText(s: CloneState, dir: FileHandle, dirAbs: string, leaf: string, rel: string): Promise<string | null> {
  const st = await lstatIn(dir, leaf)
  if (!st) return null
  if (!st.isFile()) {
    skip(s, rel, whyNot(st))
    return null
  }
  return readOpt({ abs: path.join(dirAbs, leaf), check: s.srcCheck }, MAX_FILE_BYTES)
}

/**
 * src is another MID's tree (midsvc-owned, untrusted): files are read through verified fds (every path component
 * must be a real directory inside src), symlinks and special files are skipped (never followed) and returned for the
 * caller to journal. Never touches agent/security. Secret/encrypted config.xml values are cleared (warning names them).
 */
export async function cloneFiles(src: string, dst: string, signal?: AbortSignal): Promise<{ skipped: string[]; warnings: string[] }> {
  const srcRoot = await resolveMidPath(src, "")
  const [dx, dw, dExt] = await Promise.all([target(dst, CONFIG_XML), target(dst, WRAPPER_OVERRIDE), target(dst, EXTLIB)])
  const dstRoot = await resolveMidPath(dst, "")
  const s: CloneState = { entries: 0, bytes: 0, skipped: [], skippedExtra: 0, srcCheck: insideCheck(srcRoot), dstCheck: insideCheck(dstRoot), signal }
  const warnings: string[] = []

  const agentAbs = path.join(srcRoot, "agent")
  let agent: FileHandle
  try {
    agent = await openDir(agentAbs, s.srcCheck)
  } catch (e) {
    return translateFsError(e)
  }
  try {
    const xml = await srcText(s, agent, agentAbs, "config.xml", CONFIG_XML)
    if (xml !== null) {
      signal?.throwIfAborted()
      const secrets = new Set<string>()
      for (const p of readParamAttrs(xml)) {
        const a = p.attrs
        const flagged = a.secure?.toLowerCase() === "true" || a.encrypt?.toLowerCase() === "true" || (a.value ?? "").startsWith("ENCv2[")
        if (flagged && (a.value ?? "") !== "") secrets.add(p.name)
      }
      const changes: Record<string, string> = { mid_sys_id: "" }
      for (const n of secrets) changes[n] = ""
      const cleared = setParams(xml, changes)
      const v = validateXml(cleared)
      if (!v.ok) throw xmlError(v.line)
      await writeFileAt(dx, Buffer.from(cleared, "utf8"))
      if (secrets.size > 0) {
        warnings.push(`ล้างค่าที่เข้ารหัส/เป็นความลับใน config.xml แล้ว ต้องกรอกใหม่: ${[...secrets].map(cleanName).join(", ")}`)
      }
    } else if (s.skipped.length === 0) {
      throw new MidError("not_found")
    }

    const confAbs = path.join(agentAbs, "conf")
    let conf: FileHandle | null = null
    try {
      conf = await openDir(confAbs, s.srcCheck)
    } catch (e) {
      if (!isEnoent(e)) return translateFsError(e)
    }
    if (conf) {
      try {
        const wrap = await srcText(s, conf, confAbs, "wrapper-override.conf", WRAPPER_OVERRIDE)
        if (wrap !== null) await writeFileAt(dw, Buffer.from(wrap, "utf8"))
      } finally {
        await conf.close()
      }
    }

    const extSt = await lstatIn(agent, "extlib")
    if (extSt?.isDirectory()) {
      await ensureDir(path.dirname(dExt.abs), "extlib", s.dstCheck)
      try {
        await copyDir(s, path.join(agentAbs, "extlib"), dExt.abs, EXTLIB, 0)
      } catch (e) {
        if (e instanceof MidError || signal?.aborted) throw e
        return translateFsError(e)
      }
    } else if (extSt) {
      skip(s, EXTLIB, whyNot(extSt))
    }
  } finally {
    await agent.close()
  }
  const skipped = s.skipped
  if (s.skippedExtra > 0) skipped.push(`…และอีก ${s.skippedExtra} รายการ`)
  return { skipped, warnings }
}
