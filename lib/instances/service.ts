import { prisma } from "@/lib/db/client"
import { decryptSecret, encryptSecret } from "@/lib/vault"
import { MidError } from "@/lib/mids/names"
import { buildstampFromGlideWar } from "@/lib/mids/buildstamp"
import type { SessionPayload } from "@/lib/auth/jwt"
import { normalizeInstanceUrl } from "./url"

export { normalizeInstanceUrl }

export type InstanceView = {
  id: string
  label: string
  url: string
  midUser: string | null
  hasPassword: boolean
  buildstamp: string | null
  createdBy: string
  createdAt: string
}

type Row = {
  id: string; label: string; url: string; midUser: string | null; midPasswordEnc: string | null
  buildstamp: string | null; createdBy: string; createdAt: Date
}

const TIMEOUT_MS = 15_000
const EXCERPT = 300

const view = (r: Row): InstanceView => ({
  id: r.id, label: r.label, url: r.url, midUser: r.midUser, hasPassword: !!r.midPasswordEnc,
  buildstamp: r.buildstamp, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
})

const unreachable = (detail: string) => new MidError("instance_unreachable", undefined, undefined, detail)

/**
 * Checks the credentials against the instance (GET ecc_agent), then best-effort reads glide.war.
 * SSRF-hardened: the request URL is built only from the normalised *.service-now.com URL, redirects are
 * never followed, and neither the password nor the Authorization header ever reaches an error/detail.
 */
export async function testConnection(
  input: { url: string; midUser: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; buildstamp: string | null }> {
  const base = normalizeInstanceUrl(input.url) // throws before any network call
  const headers = {
    Authorization: "Basic " + Buffer.from(`${input.midUser}:${input.password}`, "utf8").toString("base64"),
    Accept: "application/json",
  }
  const get = (path: string) =>
    fetchImpl(base + path, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })

  let res: Response
  try {
    res = await get("api/now/table/ecc_agent?sysparm_limit=1")
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: unknown } }
    const code = typeof err.cause?.code === "string" ? ` (${err.cause.code})` : ""
    throw unreachable(err.name === "TimeoutError" || err.name === "AbortError" ? "หมดเวลา 15 วินาที" : `เชื่อมต่อไม่สำเร็จ${code}`)
  }
  if (res.status === 401) throw new MidError("instance_auth")
  if (res.status === 403) throw new MidError("instance_role")
  if (res.status !== 200) {
    const excerpt = (await res.text().catch(() => "")).slice(0, EXCERPT)
    throw unreachable(`HTTP ${res.status}${excerpt ? `: ${excerpt}` : ""}`)
  }
  await res.body?.cancel().catch(() => {})

  let buildstamp: string | null = null
  try {
    const r = await get("api/now/table/sys_properties?sysparm_query=name=glide.war&sysparm_fields=value&sysparm_limit=1")
    if (r.status === 200) {
      const j = (await r.json()) as { result?: { value?: unknown }[] }
      const v = j.result?.[0]?.value
      if (typeof v === "string") buildstamp = buildstampFromGlideWar(v)
    }
  } catch { /* best effort */ }
  return { ok: true, buildstamp }
}

export async function listInstances(): Promise<InstanceView[]> {
  const rows = await prisma.instance.findMany({ orderBy: { createdAt: "asc" } })
  return rows.map(view)
}

const need = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new MidError("invalid_request", 400, undefined, `ต้องระบุ ${what}`)
  return v
}

export async function createInstance(
  user: SessionPayload,
  input: { label?: string; url: string; midUser: string; password: string },
): Promise<InstanceView> {
  const url = normalizeInstanceUrl(input.url)
  const midUser = need(input.midUser, "MID user").trim()
  const password = need(input.password, "password")
  if (await prisma.instance.findUnique({ where: { url } })) throw dup()
  const t = await testConnection({ url, midUser, password })
  const label = input.label?.trim() || new URL(url).hostname
  try {
    const row = await prisma.instance.create({
      data: { label, url, midUser, midPasswordEnc: encryptSecret(password), buildstamp: t.buildstamp, createdBy: user.email },
    })
    return view(row)
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw dup()
    throw e
  }
}

const dup = () => new MidError("conflict", 409, "มี instance URL นี้อยู่แล้ว")
const missing = () => new MidError("not_found", 404, "ไม่พบ instance อาจถูกลบไปแล้ว รีเฟรชหน้าแล้วลองใหม่")

export async function updateInstance(
  _user: SessionPayload,
  id: string,
  patch: { label?: string; midUser?: string; password?: string; buildstamp?: string | null },
): Promise<InstanceView> {
  const cur = await prisma.instance.findUnique({ where: { id } })
  if (!cur) throw missing()
  const data: Partial<Pick<Row, "label" | "midUser" | "midPasswordEnc" | "buildstamp">> = {}
  if (patch.label !== undefined) data.label = need(patch.label, "ชื่อ").trim()
  const userChanged = patch.midUser !== undefined
  const pwChanged = patch.password !== undefined
  if (userChanged || pwChanged) {
    const midUser = userChanged ? need(patch.midUser, "MID user").trim() : cur.midUser
    const password = pwChanged ? need(patch.password, "password") : cur.midPasswordEnc ? decryptSecret(cur.midPasswordEnc) : null
    if (!midUser || !password) throw new MidError("invalid_request", 400, undefined, "ต้องระบุทั้ง MID user และ password")
    const t = await testConnection({ url: cur.url, midUser, password })
    data.midUser = midUser
    if (pwChanged) data.midPasswordEnc = encryptSecret(password)
    if (t.buildstamp) data.buildstamp = t.buildstamp
  }
  if (patch.buildstamp !== undefined) data.buildstamp = patch.buildstamp
  if (Object.keys(data).length === 0) throw new MidError("invalid_request", 400, undefined, "ไม่มีข้อมูลที่ต้องแก้ไข")
  const row = await prisma.instance.update({ where: { id }, data })
  return view(row)
}

export async function deleteInstance(_user: SessionPayload, id: string): Promise<InstanceView> {
  const cur = await prisma.instance.findUnique({ where: { id } })
  if (!cur) throw missing()
  const used = await prisma.midServer.count({ where: { instanceId: id, removedAt: null } })
  if (used > 0) throw new MidError("conflict", 409, "ยังมี MID ที่ใช้ instance นี้อยู่")
  await prisma.instance.delete({ where: { id } })
  return view(cur)
}

/** Server-only (install job): decrypted credentials. Never return this from a route. */
export async function getInstanceSecret(id: string): Promise<{ url: string; midUser: string; password: string; buildstamp: string | null }> {
  const r = await prisma.instance.findUnique({ where: { id } })
  if (!r) throw missing()
  if (!r.midUser || !r.midPasswordEnc) {
    throw new MidError("invalid_request", 400, "instance นี้ยังไม่ได้ตั้ง MID user/password ไปตั้งที่หน้า Admin > Instances")
  }
  return { url: r.url, midUser: r.midUser, password: decryptSecret(r.midPasswordEnc), buildstamp: r.buildstamp }
}
