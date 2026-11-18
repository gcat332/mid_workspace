import { beforeEach, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/helpers", () => ({ requireUser: vi.fn(async () => ({ userId: "u1" })) }))
vi.mock("@/lib/mids/registry", () => ({ getMid: vi.fn(async () => ({})) }))
vi.mock("@/lib/mids/files", () => ({ isLogKey: (k: string) => k === "main" || k === "wrapper", openLog: vi.fn(async () => async () => { throw new Error("unused") }), openDownload: vi.fn() }))
vi.mock("@/lib/mids/log-tail", () => ({
  // Never yields; ends when aborted.
  tailFile: async function* (_o: unknown, opts: { signal: AbortSignal }) {
    await new Promise<void>((r) => opts.signal.addEventListener("abort", () => r(), { once: true }))
  },
}))

const ctx = { params: Promise.resolve({ name: "m1" }) }
const get = (q: string, ac = new AbortController()) => import("./route").then((m) => m.GET(new Request(`http://x/api/mids/m1/logs${q}`, { signal: ac.signal }), ctx))
beforeEach(() => vi.resetModules())

it("invalid file -> 400", async () => {
  expect((await get("?file=../../etc/passwd")).status).toBe(400)
})

it("streams SSE with the required headers", async () => {
  const ac = new AbortController()
  const res = await get("?file=main", ac)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform")
  expect(res.headers.get("x-accel-buffering")).toBe("no")
  ac.abort()
  await res.body!.cancel().catch(() => {})
})

it("21st concurrent tail -> 429", async () => {
  const acs = Array.from({ length: 20 }, () => new AbortController())
  const open = await Promise.all(acs.map((a) => get("?file=main", a)))
  expect(open.every((r) => r.status === 200)).toBe(true)
  const res = await get("?file=wrapper")
  expect(res.status).toBe(429)
  acs.forEach((a) => a.abort())
  await Promise.all(open.map((r) => r.body!.cancel().catch(() => {})))
  expect((await get("?file=main")).status).toBe(200) // slot released
})
