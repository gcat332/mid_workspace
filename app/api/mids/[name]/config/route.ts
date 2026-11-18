import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/helpers"
import { handleRouteError } from "@/lib/http/route"
import { loadConfigFiles, saveConfigFile, saveForm, type ConfigFile, type ConfigFormInput } from "@/lib/mids/config-service"
import { MidError } from "@/lib/mids/names"

type Ctx = { params: Promise<{ name: string }> }

const bad = () => new MidError("invalid_request")
const str = (v: unknown): string => (typeof v === "string" ? v : (() => { throw bad() })())

function parseForm(v: unknown): ConfigFormInput {
  if (typeof v !== "object" || v === null) throw bad()
  const f = v as Record<string, unknown>
  if (typeof f.useProxy !== "boolean" || typeof f.heapMb !== "number") throw bad()
  const opt = (x: unknown) => (x === undefined ? undefined : str(x))
  return {
    url: str(f.url), username: str(f.username), midName: str(f.midName), useProxy: f.useProxy,
    proxyHost: str(f.proxyHost), proxyPort: str(f.proxyPort), proxyUser: str(f.proxyUser), heapMb: f.heapMb,
    password: opt(f.password), proxyPassword: opt(f.proxyPassword),
  }
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser()
    return NextResponse.json(await loadConfigFiles((await ctx.params).name))
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser()
    const { name } = await ctx.params
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (typeof body !== "object" || body === null) throw bad()
    const baseHash = str(body.baseHash)
    if (body.form !== undefined) await saveForm(name, parseForm(body.form), baseHash, str(body.wrapperBaseHash), user)
    else {
      const note = body.note === undefined ? undefined : str(body.note)
      await saveConfigFile(name, str(body.file) as ConfigFile, str(body.content), baseHash, user, note)
    }
    return NextResponse.json({ ok: true, ...(await loadConfigFiles(name)) })
  } catch (e) {
    return handleRouteError(e)
  }
}
