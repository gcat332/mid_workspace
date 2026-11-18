import { agentRoute } from "@/lib/agent/http"
import { agentAuditDetail, usableMidParam } from "@/lib/agent/checks"
import { recordAudit } from "@/lib/audit"
import { readJsonObject } from "@/lib/http/route"
import { dirReadOnly, listDir, mkdir, readText, remove, rename, uploadStream, writeText } from "@/lib/mids/files"
import { MidError } from "@/lib/mids/names"

type Ctx = { params: Promise<{ name: string }> }

// Spec 5.3, same semantics and rules as the browser files tab (lib/mids/files.ts does every check and fd-verified I/O):
// GET    ?path=                       -> { entries, readOnly }
// GET    ?path=&content=1             -> { content, hash }
// PUT    { path, content, baseHash }  -> { hash }            (baseHash "" = new file)
// POST   ?dir=&filename=  raw body, Content-Length required -> { size, path }
// POST   { op: "mkdir", parent, name } | { op: "rename", path, newName } -> {} | { to }
// DELETE ?path=                       -> {}
const bad = () => new MidError("invalid_request")
const str = (v: unknown): string => {
  if (typeof v !== "string") throw bad()
  return v
}
const clean = (p: string) => p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")

/** Parallel agent uploads per process (bounds open fds, temp files and disk churn); kept on globalThis so dev reloads share it. */
const MAX_PARALLEL_UPLOADS = 2
const slots = globalThis as typeof globalThis & { __midhubAgentUploads?: number }
const BUSY_MSG = "มีการอัปโหลดจาก AgentHub กำลังทำอยู่ครบ 2 รายการแล้ว รอให้รายการก่อนหน้าเสร็จแล้วลองใหม่"

export const GET = agentRoute<Ctx>(async (req, caller, ctx) => {
  const { name } = await usableMidParam(caller, ctx.params)
  const sp = new URL(req.url).searchParams
  const p = sp.get("path") ?? ""
  if (sp.get("content") === "1") return Response.json(await readText(name, p))
  const [entries, readOnly] = await Promise.all([listDir(name, p), dirReadOnly(name, p)])
  return Response.json({ entries, readOnly })
})

export const PUT = agentRoute<Ctx>(async (req, caller, ctx) => {
  const { name } = await usableMidParam(caller, ctx.params)
  const b = await readJsonObject(req)
  if (!b) throw bad()
  const p = str(b.path)
  const r = await writeText(name, p, str(b.content), str(b.baseHash))
  await recordAudit(caller.user, "agent.file.write", name, { ...agentAuditDetail(caller), path: clean(p) })
  return Response.json(r)
})

export const POST = agentRoute<Ctx>(async (req, caller, ctx) => {
  const { name } = await usableMidParam(caller, ctx.params)
  const sp = new URL(req.url).searchParams
  const filename = sp.get("filename")
  if (filename !== null) {
    const lenHeader = req.headers.get("content-length")
    const declared = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : Number.NaN // NaN -> length_required
    if ((slots.__midhubAgentUploads ?? 0) >= MAX_PARALLEL_UPLOADS) throw new MidError("busy", 429, BUSY_MSG)
    slots.__midhubAgentUploads = (slots.__midhubAgentUploads ?? 0) + 1
    let r: Awaited<ReturnType<typeof uploadStream>>
    try {
      r = await uploadStream(name, sp.get("dir") ?? "", filename, req.body, declared)
    } finally {
      slots.__midhubAgentUploads = (slots.__midhubAgentUploads ?? 1) - 1
    }
    await recordAudit(caller.user, "agent.file.upload", name, { ...agentAuditDetail(caller), path: r.path, size: r.size })
    return Response.json(r)
  }
  const b = await readJsonObject(req)
  if (!b) throw bad()
  if (b.op === "mkdir") {
    const r = await mkdir(name, str(b.parent), str(b.name))
    await recordAudit(caller.user, "agent.file.mkdir", name, { ...agentAuditDetail(caller), path: r.path })
    return Response.json({})
  }
  if (b.op === "rename") {
    const p = str(b.path)
    const r = await rename(name, p, str(b.newName))
    await recordAudit(caller.user, "agent.file.rename", name, { ...agentAuditDetail(caller), path: p.replace(/\/+$/, ""), to: r.to })
    return Response.json(r)
  }
  throw bad()
})

export const DELETE = agentRoute<Ctx>(async (req, caller, ctx) => {
  const { name } = await usableMidParam(caller, ctx.params)
  const r = await remove(name, new URL(req.url).searchParams.get("path") ?? "")
  await recordAudit(caller.user, "agent.file.delete", name, { ...agentAuditDetail(caller), path: r.path })
  return Response.json({})
})
