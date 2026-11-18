import { beforeEach, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/helpers", () => ({ requireUser: vi.fn(async () => ({ userId: "u1", email: "a@x.com", role: "member" })) }))
const audit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
const upload = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mids/files", async (orig) => ({ ...(await orig<typeof import("@/lib/mids/files")>()), upload }))
vi.mock("@/lib/mids/registry", () => ({ getMid: vi.fn() }))

const ctx = { params: Promise.resolve({ name: "m1" }) }
const FIFTY = 50 * 1024 * 1024
function req(headers: Record<string, string>, form?: FormData) {
  const r = new Request("http://x/api/mids/m1/files", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", ...headers }, body: "--x--" })
  if (form) vi.spyOn(r, "formData").mockResolvedValue(form)
  return r
}
function formWith(size: number) {
  const f = new FormData()
  f.set("dir", "work")
  f.set("file", new File([new Uint8Array(size)], "a.bin"))
  return f
}
beforeEach(() => { upload.mockReset(); audit.mockClear() })

it("missing Content-Length -> 411", async () => {
  const { POST } = await import("./route")
  const res = await POST(req({}), ctx)
  expect(res.status).toBe(411)
  expect((await res.json()).code).toBe("length_required")
  expect(upload).not.toHaveBeenCalled()
})

it("Content-Length over 51 MB -> 413", async () => {
  const { POST } = await import("./route")
  expect((await POST(req({ "content-length": String(51 * 1024 * 1024 + 1) }), ctx)).status).toBe(413)
})

it("50 MB plus framing passes the early check; exactly 50 MB file is uploaded", async () => {
  const { POST } = await import("./route")
  upload.mockResolvedValue({ size: FIFTY, path: "work/a.bin" })
  const res = await POST(req({ "content-length": String(FIFTY + 1000) }, formWith(FIFTY)), ctx)
  expect(res.status).toBe(200)
  expect(audit).toHaveBeenCalledWith(expect.anything(), "file.upload", "m1", { path: "work/a.bin", size: FIFTY })
})

it("file over 50 MB inside an allowed body -> 413", async () => {
  const { POST } = await import("./route")
  const res = await POST(req({ "content-length": String(FIFTY + 2000) }, formWith(FIFTY + 1)), ctx)
  expect(res.status).toBe(413)
})

it("more than 2 concurrent uploads -> 429 busy", async () => {
  const { POST } = await import("./route")
  const release: Array<() => void> = []
  upload.mockImplementation(() => new Promise((r) => release.push(() => r({ size: 1, path: "work/a.bin" }))))
  const mk = () => POST(req({ "content-length": "100" }, formWith(1)), ctx)
  const a = mk(), b = mk()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  const c = await mk()
  expect(c.status).toBe(429)
  expect((await c.json()).code).toBe("busy")
  release.forEach((f) => f())
  expect((await a).status).toBe(200)
  expect((await b).status).toBe(200)
  upload.mockResolvedValue({ size: 1, path: "work/a.bin" })
  expect((await mk()).status).toBe(200)
})
