import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import type { SessionPayload } from "@/lib/auth/jwt"
import { readParams } from "./config-xml"
import { CONFIG_XML, WRAPPER_OVERRIDE } from "./layout"
import { MidError, midRoot, unitName, validateMidName } from "./names"
import { resolveMidPath } from "./paths"
import { readServiceStatus, type ServiceStatus } from "./status"
import { readHeapMb } from "./wrapper-conf"

export type MidSummary = {
  name: string
  instanceUrl: string | null
  midName: string | null
  heapMb: number
  version: string | null
  state: string
  status: ServiceStatus
}

const SYSTEMCTL = "/usr/bin/systemctl"
const UNKNOWN: ServiceStatus = { state: "unknown", pid: null, memoryBytes: null, since: null }

function unitLoaded(unit: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(SYSTEMCTL, ["show", unit, "--property=LoadState"], { timeout: 10_000 }, (err, stdout) => {
      resolve(!err && /^LoadState=loaded$/m.test(stdout))
    })
  })
}

/** Injectable for tests. */
export const deps = { unitLoaded, readStatus: readServiceStatus }

/** Reads a MID-relative text file; null when it does not exist or cannot be read. */
async function readMidFile(name: string, rel: string): Promise<string | null> {
  try {
    return await readFile(await resolveMidPath(name, rel), "utf8")
  } catch {
    return null
  }
}

/** "https://Demo.service-now.com/" -> "https://demo.service-now.com"; null when not an http(s) URL. */
function normalizeUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return null
  }
}

type Row = { name: string; state: string; heapMb: number; version: string | null; instanceId: string | null }

async function summarize(row: Row): Promise<MidSummary> {
  const [xml, inst, status] = await Promise.all([
    readMidFile(row.name, CONFIG_XML),
    row.instanceId ? prisma.instance.findUnique({ where: { id: row.instanceId } }) : null,
    deps.readStatus(row.name).catch(() => UNKNOWN),
  ])
  let params: Record<string, string> = {}
  if (xml !== null) {
    try {
      params = readParams(xml)
    } catch {
      // unreadable config: keep nulls
    }
  }
  return {
    name: row.name,
    instanceUrl: inst?.url ?? normalizeUrl(params.url),
    midName: params.name ?? null,
    heapMb: row.heapMb,
    version: row.version,
    state: row.state,
    status,
  }
}

export async function listMids(): Promise<MidSummary[]> {
  const rows = await prisma.midServer.findMany({ where: { state: { not: "removed" } }, orderBy: { name: "asc" } })
  return Promise.all(rows.map(summarize))
}

export async function getMid(name: string): Promise<MidSummary> {
  validateMidName(name)
  const row = await prisma.midServer.findUnique({ where: { name } })
  if (!row || row.state === "removed") throw new MidError("not_found")
  return summarize(row)
}

export async function importMid(name: string, user: SessionPayload): Promise<MidSummary> {
  validateMidName(name)
  let xml: string
  try {
    xml = await readFile(await resolveMidPath(name, CONFIG_XML), "utf8")
  } catch (e) {
    if (e instanceof MidError && e.code !== "not_found") throw e
    if (e instanceof MidError || (e as NodeJS.ErrnoException).code === "ENOENT") throw new MidError("not_a_mid")
    throw e
  }
  const existing = await prisma.midServer.findUnique({ where: { name } })
  if (existing && existing.state !== "removed") {
    throw new MidError("conflict", 409, "MID นี้ถูกนำเข้าแล้ว ดูได้ในรายการ MID")
  }
  const unit = unitName(name)
  if (!(await deps.unitLoaded(unit))) {
    throw new MidError(
      "not_found",
      404,
      `ไม่พบ systemd unit ${unit} สำหรับ MID นี้ กรุณาให้ Admin สร้าง unit ก่อนแล้วนำเข้าอีกครั้ง`,
    )
  }

  const params = readParams(xml)
  const url = normalizeUrl(params.url)
  let instanceId: string | null = null
  if (url) {
    const inst =
      (await prisma.instance.findUnique({ where: { url } })) ??
      (await prisma.instance.create({ data: { url, label: new URL(url).host, createdBy: user.email } }))
    instanceId = inst.id
  }
  const heapMb = readHeapMb((await readMidFile(name, WRAPPER_OVERRIDE)) ?? "") ?? 1024
  const data = { dir: midRoot(name), serviceName: unit, heapMb, state: "installed", instanceId, removedAt: null }
  const row = existing
    ? await prisma.midServer.update({ where: { name }, data: { ...data, createdBy: user.email } })
    : await prisma.midServer.create({ data: { name, ...data, createdBy: user.email } })
  await recordAudit(user, "mid.import", name, { instanceUrl: url, revived: Boolean(existing) })
  return summarize(row)
}
