// Writes a freshly extracted MID's config (config.xml, wrapper-override.conf, glide.properties) and copies the
// selected files from another MID (clone). Every file access under mids/ goes through safe-fs handles with a
// real-path check against the MID root (same approach as config-service.ts, whose helpers are DB/audit-coupled and
// private). Secrets (password, proxy password) are never logged or put into errors.
import path from "node:path"
import type { FileHandle } from "node:fs/promises"
import fs from "node:fs"
import { MAX_HEAP_MB, MIN_HEAP_MB } from "@/lib/helper/protocol"
import { setParams, validateXml } from "./config-xml"
import { setProp } from "./java-props"
import { CONFIG_XML, GLIDE_PROPERTIES, LOG_COUNT_KEYS, MAX_LOG_FILES, MIN_LOG_FILES, WRAPPER_OVERRIDE } from "./layout"
import { MidError } from "./names"
import { resolveMidPath } from "./paths"
import {
  createFileIn, fdPath, insideCheck, lstatIn, mkdirIn, openDir, openFile, readAll, readFileVerified, translateFsError, type Check,
} from "./safe-fs"
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
const EXTLIB = "agent/extlib"

const bad = (detail: string): MidError => new MidError("invalid_request", undefined, undefined, detail)

type Target = { abs: string; check: Check }
async function target(name: string, rel: string): Promise<Target> {
  const root = await resolveMidPath(name, "")
  return { abs: await resolveMidPath(name, rel), check: insideCheck(root) }
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT"

/** Whole file through a verified fd; null when it does not exist. */
async function readOpt(t: Target): Promise<string | null> {
  try {
    return (await readFileVerified(t.abs, t.check, MAX_FILE_BYTES)).toString("utf8")
  } catch (e) {
    if (isEnoent(e)) return null
    return translateFsError(e)
  }
}

/** Overwrites in place (owner/group kept), or creates the file (0664) in its verified directory. */
async function writeFileAt(t: Target, data: Buffer, mode?: number): Promise<void> {
  try {
    let h: FileHandle
    try {
      h = (await openFile(t.abs, "rw", t.check)).h
    } catch (e) {
      if (!isEnoent(e)) throw e
      const dir = path.dirname(t.abs)
      const d = await openDir(dir, t.check)
      try {
        h = await createFileIn(d, dir, path.basename(t.abs), t.check)
      } finally {
        await d.close()
      }
    }
    try {
      await h.truncate(0)
      await h.write(data, 0, data.length, 0)
      if (mode !== undefined) await h.chmod(mode)
    } finally {
      await h.close()
    }
  } catch (e) {
    return translateFsError(e)
  }
}

const writeText = (t: Target, s: string) => writeFileAt(t, Buffer.from(s, "utf8"))

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

  const xml = await readOpt(xmlT)
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
  if (!v.ok) throw new MidError("invalid_xml", 400, undefined, `line ${v.line}`) // message omitted: it may quote values

  const wrap = (await readOpt(wrapT)) ?? ""
  const nextWrap = setProp(setHeapMb(wrap, input.heapMb), LOG_COUNT_KEYS.wrapper, String(input.logFiles))

  const glide = await readOpt(glideT)
  let nextGlide: string | null = null
  if (glide === null) warnings.push("ไม่พบ agent/properties/glide.properties จึงไม่ได้ตั้งจำนวนไฟล์ log ของ MID/security")
  else nextGlide = setProp(setProp(glide, LOG_COUNT_KEYS.mid, String(input.logFiles)), LOG_COUNT_KEYS.security, String(input.logFiles))

  if (nextXml !== xml) await writeText(xmlT, nextXml)
  if (nextWrap !== wrap) await writeText(wrapT, nextWrap)
  if (nextGlide !== null && nextGlide !== glide) await writeText(glideT, nextGlide)
  return { warnings }
}

type CloneState = { files: number; bytes: number; skipped: string[]; srcCheck: Check; dstCheck: Check }

/** Opens `<parent>/<name>` as a directory, creating it (2775) under the verified parent when missing. */
async function ensureDir(parent: string, name: string, check: Check): Promise<FileHandle> {
  const p = await openDir(parent, check)
  try {
    if (!(await lstatIn(p, name))) await mkdirIn(p, parent, name, check)
  } finally {
    await p.close()
  }
  return openDir(path.join(parent, name), check)
}

async function copyFile(s: CloneState, srcDir: FileHandle, srcAbs: string, dstDirAbs: string, name: string, rel: string): Promise<void> {
  const { h, st } = await openFile(srcAbs, "r", s.srcCheck, fdPath(srcDir, name))
  try {
    if (st.nlink !== 1) {
      s.skipped.push(`${rel} (hardlink)`)
      return
    }
    if (++s.files > CLONE_MAX_FILES) throw bad(`extlib files > ${CLONE_MAX_FILES}`)
    s.bytes += st.size
    if (s.bytes > CLONE_MAX_BYTES) throw bad(`extlib bytes > ${CLONE_MAX_BYTES}`)
    const data = await readAll(h, st.size) // a file that grew after fstat is cut at its size
    await writeFileAt({ abs: path.join(dstDirAbs, name), check: s.dstCheck }, data, st.mode & 0o111 ? 0o775 : 0o664)
  } finally {
    await h.close()
  }
}

async function copyTree(s: CloneState, srcAbs: string, dstAbs: string, rel: string): Promise<void> {
  const d = await openDir(srcAbs, s.srcCheck)
  try {
    for (const n of await fs.promises.readdir(fdPath(d))) {
      const r = `${rel}/${n}`
      const st = await lstatIn(d, n)
      if (!st) continue
      if (st.isDirectory()) {
        const dd = await ensureDir(dstAbs, n, s.dstCheck)
        await dd.close()
        await copyTree(s, path.join(srcAbs, n), path.join(dstAbs, n), r)
      } else if (st.isFile()) {
        await copyFile(s, d, path.join(srcAbs, n), dstAbs, n, r)
      } else {
        s.skipped.push(`${r} (${st.isSymbolicLink() ? "symlink" : "not a regular file"})`)
      }
    }
  } finally {
    await d.close()
  }
}

/**
 * src is another MID's tree (midsvc-owned, untrusted): files are read through verified fds, symlinks and special
 * files are skipped (never followed) and returned for the caller to journal. Never touches agent/security.
 */
export async function cloneFiles(src: string, dst: string): Promise<{ skipped: string[] }> {
  const [sx, sw, dx, dw] = await Promise.all([target(src, CONFIG_XML), target(src, WRAPPER_OVERRIDE), target(dst, CONFIG_XML), target(dst, WRAPPER_OVERRIDE)])
  const srcRoot = await resolveMidPath(src, "")
  const dstRoot = await resolveMidPath(dst, "")
  const state: CloneState = { files: 0, bytes: 0, skipped: [], srcCheck: insideCheck(srcRoot), dstCheck: insideCheck(dstRoot) }

  const xml = await readOpt(sx)
  if (xml === null) throw new MidError("not_found")
  const cleared = setParams(xml, { mid_sys_id: "" })
  if (!validateXml(cleared).ok) throw new MidError("invalid_xml")
  await writeText(dx, cleared)

  const wrap = await readOpt(sw)
  if (wrap !== null) await writeText(dw, wrap)

  const srcExt = await resolveMidPath(src, EXTLIB).catch((e) => (isEnoent(e) || (e instanceof MidError && e.code === "not_found") ? null : Promise.reject(e)))
  if (srcExt !== null) {
    let ok = true
    try {
      await (await openDir(srcExt, state.srcCheck)).close()
    } catch (e) {
      if (!isEnoent(e)) return translateFsError(e)
      ok = false
    }
    if (ok) {
      const dstAgent = await resolveMidPath(dst, "agent")
      const dd = await ensureDir(dstAgent, "extlib", state.dstCheck)
      await dd.close()
      try {
        await copyTree(state, srcExt, await resolveMidPath(dst, EXTLIB), EXTLIB)
      } catch (e) {
        if (e instanceof MidError) throw e
        return translateFsError(e)
      }
    }
  }
  return { skipped: state.skipped }
}

