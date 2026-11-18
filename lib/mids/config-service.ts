import path from "node:path"
import type { FileHandle } from "node:fs/promises"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import type { SessionPayload } from "@/lib/auth/jwt"
import { callHelper } from "@/lib/helper/client"
import { MAX_HEAP_MB, MIN_HEAP_MB } from "@/lib/helper/protocol"
import { readAllParams, readParams, setParams, validateXml } from "./config-xml"
import { CONFIG_XML, WRAPPER_OVERRIDE } from "./layout"
import { MidError, validateMidName } from "./names"
import { isReadOnlyPath, resolveMidPath } from "./paths"
import { createFileIn, insideCheck, openDir, openFile, readAll, readFileVerified, translateFsError, type Check } from "./safe-fs"
import { readHeapMb, setHeapMb } from "./wrapper-conf"
import { sha256 } from "@/lib/hash"

export type ConfigFile = "config.xml" | "wrapper-override.conf"
export const CONFIG_FILES: readonly ConfigFile[] = ["config.xml", "wrapper-override.conf"]
const REL: Record<ConfigFile, string> = { "config.xml": CONFIG_XML, "wrapper-override.conf": WRAPPER_OVERRIDE }

export const MASK = "********"
const MAX_CONTENT_BYTES = 1024 * 1024
/** Read cap for the files on disk (above the save cap, so an oversized hand edit still loads as an error, not OOM). */
const MAX_DISK_BYTES = 2 * MAX_CONTENT_BYTES

/** Test seam: runs after paths are resolved and checked, right before the first file I/O. */
export const hooks: { beforeIo?: () => void | Promise<void> } = {}

// PROVISIONAL: confirm in spike (docs/spike-mid-linux.md)
export const FORM_PARAMS = {
  url: "url",
  username: "mid.instance.username",
  password: "mid.instance.password",
  midName: "name",
  useProxy: "mid.proxy.use_proxy",
  proxyHost: "mid.proxy.host",
  proxyPort: "mid.proxy.port",
  proxyUser: "mid.proxy.username",
  proxyPassword: "mid.proxy.password",
} as const

export type ConfigForm = {
  url: string
  username: string
  midName: string
  useProxy: boolean
  proxyHost: string
  proxyPort: string
  proxyUser: string
  heapMb: number
}
export type ConfigFormInput = ConfigForm & { password?: string; proxyPassword?: string }
export type FileState = { content: string; hash: string }
export type ConfigBackupMeta = { id: string; file: string; note: string; createdBy: string; createdAt: Date }

const isSecret = (name: string) => /password/i.test(name)

/** Replaces every secret parameter's non-empty value with MASK; every other byte is untouched. */
export function maskSecrets(xml: string): string {
  const changes: Record<string, string> = {}
  for (const [k, v] of Object.entries(readParams(xml))) if (isSecret(k) && v !== "") changes[k] = MASK
  return Object.keys(changes).length ? setParams(xml, changes) : xml
}

/**
 * Puts the on-disk value back for every secret parameter that still carries MASK. A MASK with no
 * on-disk secret of the same name (renamed or new parameter) is rejected: it would be stored literally.
 */
function unmaskSecrets(next: string, disk: string): string {
  const onDisk = readParams(disk)
  const diskCount = new Map<string, number>()
  for (const [k] of readAllParams(disk)) diskCount.set(k, (diskCount.get(k) ?? 0) + 1)
  const seen = new Map<string, number>()
  const changes: Record<string, string> = {}
  for (const [k, v] of readAllParams(next)) {
    if (v !== MASK) continue // any parameter, so a renamed secret (e.g. passwd) is caught too
    const nth = (seen.get(k) ?? 0) + 1
    seen.set(k, nth)
    if (nth > (diskCount.get(k) ?? 0)) {
      throw new MidError("mask_unresolved", 400, "พบค่า ******** ใน parameter ที่ไม่มีรหัสผ่านเดิม กรุณาใส่ค่าจริงหรือลบออก")
    }
    changes[k] = onDisk[k]
  }
  return Object.keys(changes).length ? setParams(next, changes) : next
}

async function midRow(name: string) {
  validateMidName(name)
  const row = await prisma.midServer.findUnique({ where: { name } })
  if (!row || row.state === "removed") throw new MidError("not_found")
  return row
}

type Target = { abs: string; check: Check }

/**
 * Resolved location of a managed config file plus the check every opened handle must pass: inside the MID root
 * and not in a program dir. openFile additionally pins the handle's real path to `abs`, so a file or directory
 * swapped by the MID process after this point (symlink to .env.local, the DB, app code ...) is refused.
 */
async function targetOf(name: string, file: ConfigFile): Promise<Target> {
  const root = await resolveMidPath(name, "")
  const abs = await resolveMidPath(name, REL[file])
  if (isReadOnlyPath(name, abs)) throw new MidError("read_only")
  const inside = insideCheck(root)
  return {
    abs,
    check: (real) => {
      inside(real)
      if (isReadOnlyPath(name, real)) throw new MidError("read_only")
    },
  }
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT"

async function readDisk(name: string, file: ConfigFile): Promise<string> {
  const t = await targetOf(name, file)
  await hooks.beforeIo?.()
  try {
    return (await readFileVerified(t.abs, t.check, MAX_DISK_BYTES)).toString("utf8")
  } catch (e) {
    if (isEnoent(e)) {
      if (file === "wrapper-override.conf") return "" // optional file: created on first save
      throw new MidError("not_found")
    }
    return translateFsError(e)
  }
}

/** Opens the file read-write (or null when an optional wrapper file does not exist yet). */
async function openForWrite(t: Target, file: ConfigFile): Promise<FileHandle | null> {
  try {
    const { h, st } = await openFile(t.abs, "rw", t.check)
    if (st.size > MAX_DISK_BYTES) {
      await h.close()
      throw new MidError("too_large", 413, "ไฟล์บนเครื่องใหญ่เกิน 2 MB แก้ไขผ่านหน้าเว็บไม่ได้")
    }
    return h
  } catch (e) {
    if (isEnoent(e) && file === "wrapper-override.conf") return null
    if (isEnoent(e)) throw new MidError("not_found")
    return translateFsError(e)
  }
}

/** Creates the (missing) file inside its verified parent directory; fails if it appeared meanwhile. */
async function createVerified(t: Target): Promise<FileHandle> {
  const dir = path.dirname(t.abs)
  try {
    const d = await openDir(dir, t.check)
    try {
      return await createFileIn(d, dir, path.basename(t.abs), t.check)
    } finally {
      await d.close()
    }
  } catch (e) {
    return translateFsError(e)
  }
}

// One save at a time per MID so the read -> hash check -> write window cannot interleave in this process.
const chains = new Map<string, Promise<unknown>>()
function serialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  chains.set(name, tail)
  void tail.then(() => chains.get(name) === tail && chains.delete(name))
  return run
}

function formOf(xml: string, wrapper: string): ConfigForm {
  const p = readParams(xml)
  const g = (k: keyof typeof FORM_PARAMS) => p[FORM_PARAMS[k]] ?? ""
  return {
    url: g("url"),
    username: g("username"),
    midName: g("midName"),
    useProxy: g("useProxy").trim().toLowerCase() === "true",
    proxyHost: g("proxyHost"),
    proxyPort: g("proxyPort"),
    proxyUser: g("proxyUser"),
    heapMb: readHeapMb(wrapper) ?? 1024,
  }
}

export async function loadConfigFiles(
  name: string,
): Promise<{ files: Record<ConfigFile, FileState>; form: ConfigForm; warning?: string }> {
  await midRow(name)
  const [xml, wrapper] = await Promise.all([readDisk(name, "config.xml"), readDisk(name, "wrapper-override.conf")])
  return {
    files: {
      "config.xml": { content: maskSecrets(xml), hash: sha256(xml) },
      "wrapper-override.conf": { content: wrapper, hash: sha256(wrapper) },
    },
    form: formOf(xml, wrapper),
    ...(validateXml(xml).ok ? {} : { warning: "config.xml บนเครื่องรูปแบบไม่ถูกต้อง (malformed) ค่า password อาจแสดงโดยไม่ถูกปิดบัง ตรวจสอบและแก้ไฟล์" }),
  }
}

function validate(file: ConfigFile, content: string): void {
  if (file === "config.xml") {
    const v = validateXml(content)
    if (!v.ok) {
      throw new MidError("invalid_xml", 400, `config.xml ไม่ถูกต้อง (บรรทัด ${v.line}): ${v.message} แก้ไขแล้วบันทึกใหม่`)
    }
    return
  }
  const m = /^[ \t]*wrapper\.java\.maxmemory[ \t]*=[ \t]*(.*?)[ \t]*\r?$/m.exec(content)
  if (m) {
    const mb = /^\d+$/.test(m[1]) ? Number(m[1]) : NaN
    if (!(mb >= MIN_HEAP_MB && mb <= MAX_HEAP_MB)) {
      throw new MidError("invalid_heap", 400, `wrapper.java.maxmemory ต้องเป็นจำนวนเต็ม ${MIN_HEAP_MB}-${MAX_HEAP_MB} (MB) แก้ไขแล้วบันทึกใหม่`)
    }
  }
}

type Meta = { note?: string; action: "config.save" | "config.rollback"; backupId?: string }

async function saveLocked(name: string, file: ConfigFile, content: string, baseHash: string, user: SessionPayload, meta: Meta): Promise<void> {
  if (typeof content !== "string" || typeof baseHash !== "string") throw new MidError("invalid_request")
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new MidError("too_large", 413, "ไฟล์ใหญ่เกิน 1 MB ลดขนาดแล้วลองใหม่")
  const row = await midRow(name)
  const t = await targetOf(name, file)
  await hooks.beforeIo?.()

  // read -> hash check -> backup -> truncate -> write, all on ONE verified fd (in place: owner midsvc / group midhub kept).
  let h = await openForWrite(t, file)
  let current: string
  let next: string
  try {
    current = h ? (await readAll(h, MAX_DISK_BYTES)).toString("utf8") : ""
    if (sha256(current) !== baseHash) throw new MidError("stale", 409, "ไฟล์ถูกแก้ไปแล้ว กรุณาโหลดใหม่")
    validate(file, content)
    next = file === "config.xml" ? unmaskSecrets(content, current) : content

    const backup = await prisma.configBackup.create({
      data: { midId: row.id, file, content: current, note: meta.note ?? "", createdBy: user.email },
    })
    try {
      h ??= await createVerified(t)
      const data = Buffer.from(next, "utf8")
      await h.truncate(0)
      await h.write(data, 0, data.length, 0)
    } catch (e) {
      await prisma.configBackup.delete({ where: { id: backup.id } }).catch(() => {})
      if (e instanceof MidError && e.code !== "no_permission") throw e
      throw new MidError("internal", 500, "เขียนไฟล์ไม่สำเร็จ ตรวจสอบว่ากลุ่ม midhub เขียนไฟล์นี้ได้ (หรือกด \"ซ่อมสิทธิ์ไฟล์\") แล้วลองใหม่", (e as Error).message)
    }
  } finally {
    await h?.close()
  }

  const audit = () =>
    recordAudit(
      user,
      meta.action,
      name,
      meta.action === "config.rollback" ? { file, backupId: meta.backupId } : { file, ...(meta.note ? { note: meta.note } : {}) },
    )

  const heap = file === "wrapper-override.conf" ? readHeapMb(next) : null
  if (file === "wrapper-override.conf" && heap === null && readHeapMb(current) !== null) {
    console.warn(`[config] wrapper.java.maxmemory removed from MID ${name}; service unit and MidServer.heapMb left unchanged`)
  }
  // Also when the unit is behind the file (an earlier save ended in `partial`), so saving again retries it.
  if (heap !== null && (heap !== readHeapMb(current) || heap !== row.heapMb)) {
    try {
      await callHelper({ op: "installUnit", name, heapMb: heap })
      await prisma.midServer.update({ where: { name }, data: { heapMb: heap } })
    } catch (e) {
      await audit()
      const cause = e instanceof MidError ? [e.message, e.detail].filter(Boolean).join(": ") : (e as Error).message
      throw new MidError("partial", 502, "บันทึกไฟล์แล้ว แต่ปรับ RAM ของ service ไม่สำเร็จ กรุณาบันทึกซ้ำหรือแจ้ง Admin (ดูรายละเอียดด้านล่าง)", cause)
    }
  }
  await audit()
}

export function saveConfigFile(name: string, file: ConfigFile, content: string, baseHash: string, user: SessionPayload, note?: string): Promise<void> {
  if (!CONFIG_FILES.includes(file)) throw new MidError("invalid_request")
  return serialized(name, () => saveLocked(name, file, content, baseHash, user, { note, action: "config.save" }))
}

/** Both hashes are those the form was loaded with; a mismatch on either is stale and nothing is written. */
export function saveForm(name: string, form: ConfigFormInput, baseHash: string, wrapperBaseHash: string, user: SessionPayload): Promise<void> {
  return serialized(name, async () => {
    const heap = form.heapMb
    if (!Number.isInteger(heap) || heap < MIN_HEAP_MB || heap > MAX_HEAP_MB) {
      throw new MidError("invalid_heap", 400, `RAM (heap) ต้องเป็นจำนวนเต็ม ${MIN_HEAP_MB}-${MAX_HEAP_MB} MB`)
    }
    const row = await midRow(name)
    const xml = await readDisk(name, "config.xml")
    const wrapper = await readDisk(name, "wrapper-override.conf")
    if (sha256(xml) !== baseHash || sha256(wrapper) !== wrapperBaseHash) throw new MidError("stale", 409, "ไฟล์ถูกแก้ไปแล้ว กรุณาโหลดใหม่")
    const onDisk = readParams(xml)
    const changes: Record<string, string> = {}
    const put = (k: keyof typeof FORM_PARAMS, v: string) => {
      const key = FORM_PARAMS[k]
      if ((v === "" || v === "false") && !Object.hasOwn(onDisk, key)) return // do not add empty/default parameters
      changes[key] = v
    }
    put("url", String(form.url))
    put("username", String(form.username))
    put("midName", String(form.midName))
    put("useProxy", form.useProxy ? "true" : "false")
    put("proxyHost", String(form.proxyHost))
    put("proxyPort", String(form.proxyPort))
    put("proxyUser", String(form.proxyUser))
    if (form.password) changes[FORM_PARAMS.password] = form.password
    if (form.proxyPassword) changes[FORM_PARAMS.proxyPassword] = form.proxyPassword
    const nextXml = setParams(xml, changes)
    if (nextXml !== xml) await saveLocked(name, "config.xml", nextXml, baseHash, user, { action: "config.save" })

    if (readHeapMb(wrapper) !== heap || row.heapMb !== heap) {
      await saveLocked(name, "wrapper-override.conf", setHeapMb(wrapper, heap), sha256(wrapper), user, { action: "config.save" })
    }
  })
}

export async function listBackups(name: string): Promise<ConfigBackupMeta[]> {
  const row = await midRow(name)
  return prisma.configBackup.findMany({
    where: { midId: row.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, file: true, note: true, createdBy: true, createdAt: true },
  })
}

async function backupOf(name: string, id: string) {
  const row = await midRow(name)
  const b = typeof id === "string" ? await prisma.configBackup.findUnique({ where: { id } }) : null
  if (!b || b.midId !== row.id || !CONFIG_FILES.includes(b.file as ConfigFile)) throw new MidError("not_found")
  return b
}

/** Backup including content (secrets masked) for the diff view. */
export async function getBackup(name: string, id: string): Promise<ConfigBackupMeta & { content: string }> {
  const b = await backupOf(name, id)
  return {
    id: b.id,
    file: b.file,
    note: b.note,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    content: b.file === "config.xml" ? maskSecrets(b.content) : b.content,
  }
}

export function rollback(name: string, backupId: string, user: SessionPayload): Promise<void> {
  return serialized(name, async () => {
    const b = await backupOf(name, backupId)
    const file = b.file as ConfigFile
    // Rollback is a deliberate overwrite, so it is checked against the current disk hash rather than a client's.
    const current = await readDisk(name, file)
    await saveLocked(name, file, b.content, sha256(current), user, { note: `rollback of ${b.id}`, action: "config.rollback", backupId: b.id })
  })
}
