import { prisma } from "@/lib/db/client"
import type { SessionPayload } from "@/lib/auth/jwt"
import { MAX_HEAP_MB, MIN_HEAP_MB } from "@/lib/helper/protocol"
import { getInstanceSecret } from "@/lib/instances/service"
import { BUILDSTAMP_RE } from "@/lib/mids/buildstamp"
import { findInvalidXmlChar } from "@/lib/mids/config-xml"
import { MID_NAME_RE } from "@/lib/mids/name-regex"
import { MidError, midRoot, unitName } from "@/lib/mids/names"
import { encryptSecret } from "@/lib/vault"
import { createJob, type JobKind, type JobRow } from "./engine"

const bad = (msg: string) => new MidError("invalid_request", 400, msg)
const SN_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max

export type ProxyIn = { host: string; port: number; user?: string; password?: string }
export type CreateInput = {
  instanceId: string
  name: string
  snName: string
  heapMb: number
  logFiles: number
  proxy?: ProxyIn
  cloneFrom?: string
  buildstamp?: string
}

export function parseProxy(v: unknown): ProxyIn | undefined {
  if (v === undefined || v === null) return undefined
  if (!isObj(v)) throw bad("ข้อมูล proxy ไม่ถูกต้อง")
  const { host, port, user, password } = v
  if (typeof host !== "string" || !HOST_RE.test(host)) throw bad("proxy host ต้องเป็นชื่อโฮสต์หรือ IPv4 (ไม่ต้องใส่ http:// หรือ path)")
  if (!isInt(port, 1, 65535)) throw bad("proxy port ต้องเป็นเลข 1-65535")
  if (user !== undefined && user !== "" && (typeof user !== "string" || user.length > 100)) throw bad("proxy user ยาวเกิน 100 ตัวอักษร")
  if (password !== undefined && password !== "") {
    if (typeof password !== "string" || password.length > 256) throw bad("proxy password ยาวเกิน 256 ตัวอักษร")
    if (findInvalidXmlChar(password) !== -1) throw bad("proxy password มีอักขระที่ไม่อนุญาต")
  }
  return {
    host,
    port,
    ...(user ? { user: user as string } : {}),
    ...(password ? { password: password as string } : {}),
  }
}

export function parseCreateBody(b: Record<string, unknown>): CreateInput {
  const { instanceId, name } = b
  if (typeof name !== "string" || !MID_NAME_RE.test(name)) throw new MidError("invalid_name")
  if (typeof instanceId !== "string" || !instanceId) throw bad("ต้องเลือก instance")
  const snName = b.snName === undefined || b.snName === "" ? `midhub-${name}` : b.snName
  if (typeof snName !== "string" || !SN_NAME_RE.test(snName)) throw bad("ชื่อ MID ใน ServiceNow ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-80 ตัวอักษร)")
  const heapMb = b.heapMb === undefined ? 1024 : b.heapMb
  if (!isInt(heapMb, MIN_HEAP_MB, MAX_HEAP_MB)) throw bad(`heap ต้องเป็นจำนวนเต็ม ${MIN_HEAP_MB}-${MAX_HEAP_MB} MB`)
  const logFiles = b.logFiles === undefined ? 3 : b.logFiles
  if (!isInt(logFiles, 1, 10)) throw bad("จำนวนไฟล์ log ต้องเป็น 1-10")
  let cloneFrom: string | undefined
  if (b.cloneFrom !== undefined && b.cloneFrom !== null && b.cloneFrom !== "") {
    if (typeof b.cloneFrom !== "string" || !MID_NAME_RE.test(b.cloneFrom)) throw new MidError("invalid_name")
    if (b.cloneFrom === name) throw bad("cloneFrom ต้องเป็น MID อื่น")
    cloneFrom = b.cloneFrom
  }
  let buildstamp: string | undefined
  if (b.buildstamp !== undefined && b.buildstamp !== null && b.buildstamp !== "") {
    if (typeof b.buildstamp !== "string" || !BUILDSTAMP_RE.test(b.buildstamp)) throw new MidError("invalid_buildstamp")
    buildstamp = b.buildstamp
  }
  return { instanceId, name, snName, heapMb, logFiles, proxy: parseProxy(b.proxy), cloneFrom, buildstamp }
}

type Prev = { id: string; data: { instanceId: string | null; heapMb: number; version: string | null; state: string; removedAt: Date | null; createdBy: string; dir: string; serviceName: string } } | null

/** Starts an install/clone job. The row upsert is atomic w.r.t. name conflicts; a failing createJob restores the row. */
export async function startInstall(user: SessionPayload, input: CreateInput): Promise<{ job: JobRow; kind: JobKind }> {
  const inst = await getInstanceSecret(input.instanceId) // throws not_found/invalid_request (no credentials)
  const buildstamp = input.buildstamp ?? inst.buildstamp
  if (!buildstamp || !BUILDSTAMP_RE.test(buildstamp)) {
    throw new MidError("buildstamp_unknown", 400, "ระบุ build ของ instance ไม่ได้ ให้เลือก package ที่มีอยู่หรือกรอก buildstamp")
  }
  if (input.cloneFrom) {
    const src = await prisma.midServer.findUnique({ where: { name: input.cloneFrom } })
    if (!src || src.state === "removed") throw new MidError("not_found", 404, "ไม่พบ MID ต้นทางที่จะ clone")
  }
  const params: Record<string, unknown> = {
    instanceId: input.instanceId,
    buildstamp,
    snName: input.snName,
    heapMb: input.heapMb,
    logFiles: input.logFiles,
    ...(input.cloneFrom ? { cloneFrom: input.cloneFrom } : {}),
  }
  if (input.proxy) {
    const { password, ...rest } = input.proxy
    params.proxy = { ...rest, ...(password ? { passwordEnc: encryptSecret(password) } : {}) }
  }
  const kind: JobKind = input.cloneFrom ? "clone" : "install"
  const name = input.name

  const prev: Prev = await prisma.$transaction(async (tx) => {
    const existing = await tx.midServer.findUnique({ where: { name } })
    if (existing && existing.state !== "removed") throw new MidError("conflict", 409, "มี MID ชื่อนี้อยู่แล้ว ใช้ชื่ออื่น")
    const data = { instanceId: input.instanceId, heapMb: input.heapMb, version: null, state: "installing", removedAt: null, createdBy: user.email }
    if (existing) {
      await tx.midServer.update({ where: { name }, data })
      const { id, instanceId, heapMb, version, state, removedAt, createdBy, dir, serviceName } = existing
      return { id, data: { instanceId, heapMb, version, state, removedAt, createdBy, dir, serviceName } }
    }
    await tx.midServer.create({ data: { name, ...data, dir: midRoot(name), serviceName: unitName(name) } })
    return null
  }).catch((e) => {
    if ((e as { code?: string }).code === "P2002") throw new MidError("conflict", 409, "มี MID ชื่อนี้อยู่แล้ว ใช้ชื่ออื่น")
    throw e
  })

  try {
    const job = await createJob(user, kind, name, params)
    return { job, kind }
  } catch (e) {
    await (prev
      ? prisma.midServer.update({ where: { name }, data: prev.data })
      : prisma.midServer.deleteMany({ where: { name, state: "installing" } })
    ).catch((re) => console.error("[lifecycle] rollback of MID row failed", name, re))
    throw e
  }
}

/** Starts an uninstall job for an installed/error MID; restores the previous state if the job cannot be created. */
export async function startUninstall(user: SessionPayload, name: string): Promise<JobRow> {
  const row = await prisma.midServer.findUnique({ where: { name } })
  if (!row || row.state === "removed") throw new MidError("not_found")
  if (row.state !== "installed" && row.state !== "error") {
    throw new MidError("conflict", 409, "MID นี้กำลังติดตั้งหรือถอนการติดตั้งอยู่ รอให้เสร็จก่อน")
  }
  const res = await prisma.midServer.updateMany({ where: { name, state: row.state }, data: { state: "uninstalling" } })
  if (res.count !== 1) throw new MidError("conflict")
  try {
    return await createJob(user, "uninstall", name, {})
  } catch (e) {
    await prisma.midServer.updateMany({ where: { name, state: "uninstalling" }, data: { state: row.state } })
    throw e
  }
}
