import { beforeEach, expect, it, vi } from "vitest"
import { MidError } from "@/lib/mids/names"

let signedIn = true
vi.mock("@/lib/auth/helpers", () => ({
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Response("{}", { status: 401 })
    return { userId: "u1", email: "a@x.com", role: "member" }
  }),
}))
const listMids = vi.hoisted(() => vi.fn())
const getMid = vi.hoisted(() => vi.fn())
const importMid = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mids/registry", () => ({ listMids, getMid, importMid }))

beforeEach(() => {
  signedIn = true
  listMids.mockReset()
  getMid.mockReset()
  importMid.mockReset()
})

const post = (body: unknown) => new Request("http://x/api/mids/import", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })

it("GET /api/mids: 401 signed out, list when signed in, 500 JSON on unexpected error", async () => {
  const { GET } = await import("./route")
  signedIn = false
  expect((await GET()).status).toBe(401)
  signedIn = true
  listMids.mockResolvedValueOnce([{ name: "a" }])
  expect(await (await GET()).json()).toEqual([{ name: "a" }])
  vi.spyOn(console, "error").mockImplementationOnce(() => {})
  listMids.mockRejectedValueOnce(new Error("db"))
  const res = await GET()
  expect(res.status).toBe(500)
  expect((await res.json()).code).toBe("internal")
})

it("GET /api/mids/[name]: maps MidError not_found to 404", async () => {
  const { GET } = await import("./[name]/route")
  getMid.mockRejectedValueOnce(new MidError("not_found"))
  const res = await GET(new Request("http://x"), { params: Promise.resolve({ name: "zz" }) })
  expect(res.status).toBe(404)
  getMid.mockResolvedValueOnce({ name: "ok" })
  expect(await (await GET(new Request("http://x"), { params: Promise.resolve({ name: "ok" }) })).json()).toEqual({ name: "ok" })
})

it("POST /api/mids/import: validates body, calls importMid, maps conflict", async () => {
  const { POST } = await import("./import/route")
  for (const bad of ["not json", {}, { name: 5 }]) {
    const res = await POST(post(bad))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_name")
  }
  expect(importMid).not.toHaveBeenCalled()
  importMid.mockResolvedValueOnce({ name: "m1" })
  const ok = await POST(post({ name: "m1" }))
  expect(ok.status).toBe(201)
  expect(importMid).toHaveBeenCalledWith("m1", expect.objectContaining({ email: "a@x.com" }))
  importMid.mockRejectedValueOnce(new MidError("conflict"))
  expect((await POST(post({ name: "m1" }))).status).toBe(409)
  signedIn = false
  expect((await POST(post({ name: "m1" }))).status).toBe(401)
})
