import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, readJsonObject } from "@/lib/http/route"
import { MAX_UPLOAD_BYTES, dirReadOnly, listDir, mkdir, readText, remove, rename, upload, writeText } from "@/lib/mids/files"
import { MidError } from "@/lib/mids/names"

type Ctx = { params: Promise<{ name: string }> }

// GET    ?path=            -> { entries, readOnly } (list a directory)
// GET    ?path=&content=1  -> { content, hash }     (open a text file)
// PUT    { path, content, baseHash }                -> { hash }
// POST   multipart { dir, file }                    -> { size }      (upload)
// POST   JSON { op: "mkdir", parent, name } | { op: "rename", path, newName } -> {} | { to }
// DELETE ?path=                                     -> {}
const bad = () => new MidError("invalid_request")
const str = (v: unknown): string => {
  if (typeof v !== "string") throw bad()
  return v
}
/** Matches next.config.ts proxyClientMaxBodySize ("51mb"): 50 MB of file plus multipart framing. */
export const MAX_BODY_BYTES = 51 * 1024 * 1024
/** One at a time: each upload is buffered whole (up to 50 MB) inside the 1 GB app MemoryMax. */
const MAX_CONCURRENT_UPLOADS = 1
let uploading = 0

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const { name } = await ctx.params
    const url = new URL(req.url)
    const p = url.searchParams.get("path") ?? ""
    if (url.searchParams.get("content") === "1") return NextResponse.json(await readText(name, p))
    const [entries, readOnly] = await Promise.all([listDir(name, p), dirReadOnly(name, p)])
    return NextResponse.json({ entries, readOnly })
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser()
    const { name } = await ctx.params
    const b = await readJsonObject(req)
    if (!b) throw bad()
    const path = str(b.path)
    const r = await writeText(name, path, str(b.content), str(b.baseHash))
    await recordAudit(user, "file.write", name, { path: path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/") })
    return NextResponse.json(r)
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser()
    const { name } = await ctx.params
    const type = req.headers.get("content-type") ?? ""
    if (type.startsWith("multipart/form-data")) {
      const lenHeader = req.headers.get("content-length")
      if (lenHeader === null || !/^\d+$/.test(lenHeader)) throw new MidError("length_required")
      if (Number(lenHeader) > MAX_BODY_BYTES) throw new MidError("too_large")
      if (uploading >= MAX_CONCURRENT_UPLOADS) {
        throw new MidError("busy", 429, "มีการอัปโหลดอีกรายการกำลังทำอยู่ (อัปโหลดได้ครั้งละ 1 ไฟล์) รอให้เสร็จแล้วลองใหม่")
      }
      uploading++
      try {
        const form = await req.formData().catch(() => null)
        const file = form?.get("file")
        if (!form || !(file instanceof File)) throw bad()
        if (file.size > MAX_UPLOAD_BYTES) throw new MidError("too_large")
        const r = await upload(name, str(form.get("dir") ?? ""), file.name, Buffer.from(await file.arrayBuffer()))
        await recordAudit(user, "file.upload", name, { path: r.path, size: r.size })
        return NextResponse.json({ size: r.size })
      } finally {
        uploading--
      }
    }
    const b = await readJsonObject(req)
    if (!b) throw bad()
    if (b.op === "mkdir") {
      const parent = str(b.parent)
      const dn = str(b.name)
      const r = await mkdir(name, parent, dn)
      await recordAudit(user, "file.mkdir", name, { path: r.path })
      return NextResponse.json({})
    }
    if (b.op === "rename") {
      const path = str(b.path)
      const r = await rename(name, path, str(b.newName))
      await recordAudit(user, "file.rename", name, { path: path.replace(/\/+$/, ""), to: r.to })
      return NextResponse.json(r)
    }
    throw bad()
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser()
    const { name } = await ctx.params
    const path = new URL(req.url).searchParams.get("path") ?? ""
    const r = await remove(name, path)
    await recordAudit(user, "file.delete", name, { path: r.path })
    return NextResponse.json({})
  } catch (e) {
    return handleRouteError(e)
  }
}
