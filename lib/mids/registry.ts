import { normalizeInstanceUrl } from "@/lib/instances/url"
import { prisma } from "@/lib/db/client"
import { recordAudit } from "@/lib/audit"
import { callHelper } from "@/lib/helper/client"
import type { SessionPayload } from "@/lib/auth/jwt"
import { readParams } from "./config-xml"
import { CONFIG_XML, WRAPPER_OVERRIDE } from "./layout"
import { MidError, midRoot, unitName, validateMidName } from "./names"
import { resolveMidPath } from "./paths"
import { insideCheck, readFileVerified, translateFsError } from "./safe-fs"
import { readServiceStatus, runSystemctl, type ServiceStatus } from "./status"
import { readHeapMb } from "./wrapper-conf"

export type MidSummary = {
  name: string
  instanceUrl: string | null
  /** config.xml url alone (instanceUrl prefers the linked Instance). */
  configUrl: string | null
  midName: string | null
  heapMb: number
  version: string | null
  state: string
  agentAccess: boolean
  status: ServiceStatus
  job: { id: string; kind: string; stage: string; status: string; createdAt: Date } | null
}

const UNKNOWN: ServiceStatus = { state: "unknown", pid: null, memoryBytes: null, since: null }

/** true = loaded, false = systemd says the unit is not loaded. An exec failure/timeout throws (not "missing"). */
async function unitLoaded(unit: string): Promise<boolean> {
  const r = await runSystemctl(["show", unit, "--property=LoadState"])
  if (r.code !== 0) {
    throw new MidError("internal", undefined, undefined, `systemctl show ${unit} failed (code ${r.code}): ${r.stdout.trim().slice(0, 200)}`)
  }
  return /^LoadState=loaded$/m.test(r.stdout)
}

/** Test seam: runs after paths are resolved and checked, right before the file is opened. */
export const hooks: { beforeIo?: () => void | Promise<void> } = {}

const MAX_READ_BYTES = 2 * 1024 * 1024

/**
 * MID-relative text file read through an O_NOFOLLOW fd whose real path must equal the resolved path (inside the
 * MID root), so a component swapped by the MID process after resolution cannot redirect the read.
 * Throws MidError (not_found / path_outside / ...) for every failure.
 */
async function readVerified(name: string, rel: string): Promise<string> {
  const root = await resolveMidPath(name, "")
  const abs = await resolveMidPath(name, rel)
  await hooks.beforeIo?.()
  try {
    return (await readFileVerified(abs, insideCheck(root), MAX_READ_BYTES)).toString("utf8")
  } catch (e) {
    return translateFsError(e)
  }
}

/** Injectable for tests. */
export const deps = { unitLoaded, readStatus: readServiceStatus }

/** Reads a MID-relative text file; null when it does not exist or cannot be read. */
async function readMidFile(name: string, rel: string): Promise<string | null> {
  try {
    return await readVerified(name, rel)
  } catch (e) {
    if (!(e instanceof MidError && e.code === "not_found")) {
      console.warn(`[registry] cannot read ${rel} of MID ${name}:`, (e as Error).message)
    }
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

type JobSummary = NonNullable<MidSummary["job"]>
type Row = { name: string; state: string; heapMb: number; version: string | null; instanceId: string | null; agentAccess?: boolean }

async function summarize(row: Row, knownJob?: JobSummary | null): Promise<MidSummary> {
  const [xml, inst, status, job] = await Promise.all([
    readMidFile(row.name, CONFIG_XML),
    row.instanceId ? prisma.instance.findUnique({ where: { id: row.instanceId } }) : null,
    deps.readStatus(row.name).catch((e: unknown) => {
      console.warn(`[registry] status of MID ${row.name} unavailable:`, (e as Error).message)
      return UNKNOWN
    }),
    knownJob !== undefined
      ? knownJob
      : prisma.job.findFirst({
          where: { midName: row.name },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, kind: true, stage: true, status: true, createdAt: true },
        }),
  ])
  let params: Record<string, string> = {}
  if (xml !== null) {
    try {
      params = readParams(xml)
    } catch (e) {
      console.warn(`[registry] config.xml of MID ${row.name} is unreadable:`, (e as Error).message)
    }
  }
  return {
    name: row.name,
    instanceUrl: inst?.url ?? normalizeUrl(params.url),
    configUrl: normalizeUrl(params.url),
    midName: params.name ?? null,
    heapMb: row.heapMb,
    version: row.version,
    state: row.state,
    agentAccess: row.agentAccess ?? false,
    status,
    job,
  }
}

export async function listMids(): Promise<MidSummary[]> {
  const rows = await prisma.midServer.findMany({ where: { state: { not: "removed" } }, orderBy: { name: "asc" } })
  // One query for the latest job of every listed MID (no N+1).
  const jobs = await prisma.job.findMany({
    where: { midName: { in: rows.map((r) => r.name) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, kind: true, stage: true, status: true, createdAt: true, midName: true },
  })
  const latest = new Map<string, JobSummary>()
  for (const { midName, ...j } of jobs) if (!latest.has(midName)) latest.set(midName, j)
  return Promise.all(rows.map((r) => summarize(r, latest.get(r.name) ?? null)))
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
    xml = await readVerified(name, CONFIG_XML)
  } catch (e) {
    if (e instanceof MidError && e.code === "not_found") throw new MidError("not_a_mid")
    if (e instanceof MidError) throw e
    throw new MidError("internal", undefined, undefined, `cannot read ${CONFIG_XML}: ${(e as Error).message}`)
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
  // Canonical Instance url (trailing slash). Not a valid ServiceNow URL -> no Instance is linked or created.
  let url: string | null = null
  try {
    url = normalizeInstanceUrl(params.url ?? "")
  } catch {
    console.warn(`[registry] MID ${name}: config.xml url is not a valid ServiceNow URL; no Instance linked`)
  }
  const heapMb = readHeapMb((await readMidFile(name, WRAPPER_OVERRIDE)) ?? "") ?? 1024
  let row: Row
  try {
    row = await prisma.$transaction(async (tx) => {
      let instanceId: string | null = null
      if (url) {
        const inst =
          (await tx.instance.findUnique({ where: { url } })) ??
          (await tx.instance.create({ data: { url, label: new URL(url).hostname, createdBy: user.email } }))
        instanceId = inst.id
      }
      const data = { dir: midRoot(name), serviceName: unit, heapMb, state: "installed", instanceId, removedAt: null, agentAccess: false }
      return existing
        ? tx.midServer.update({ where: { name }, data: { ...data, createdBy: user.email } })
        : tx.midServer.create({ data: { name, ...data, createdBy: user.email } })
    })
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new MidError("conflict", 409, "MID นี้ถูกนำเข้าแล้ว ดูได้ในรายการ MID")
    throw e
  }
  // A tree unpacked by hand is often owned by root or another user: hand it to midsvc:midhub (group-writable)
  // so MidHub can edit it. Best effort: the import itself already succeeded.
  let fixOwnership: string | undefined
  try {
    await callHelper({ op: "fixOwnership", name })
  } catch (e) {
    fixOwnership = `failed: ${(e as { code?: string }).code ?? "internal"}`
    console.warn(`[registry] fixOwnership after importing ${name} failed:`, (e as Error).message, (e as { detail?: string }).detail ?? "")
  }
  await recordAudit(user, "mid.import", name, { instanceUrl: url, revived: Boolean(existing), ...(fixOwnership ? { fixOwnership } : {}) })
  return summarize(row)
}
