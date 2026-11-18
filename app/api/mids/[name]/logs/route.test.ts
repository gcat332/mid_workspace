import { beforeEach, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/helpers", () => ({ requireUser: vi.fn(async () => ({ userId: "u1" })) }))
vi.mock("@/lib/mids/registry", () => ({ getMid: vi.fn(async () => ({})) }))
vi.mock("@/lib/mids/files", () => ({ isLogKey: (k: string) => k === "main" || k === "wrapper", openLog: vi.fn(async () => async () => ({ h: { close: async () => {} }, st: {} })), openDownload: vi.fn() }))
const stalled = vi.hoisted(() => ({ mode: "idle" as "idle" | "one-big" | "flood", signal: undefined as AbortSignal | undefined }))
vi.mock("@/lib/mids/log-tail", () => ({
  // idle: never yields; one-big: one 100 KB batch; flood: 300 KB batches. Ends when aborted.
  tailFile: async function* (_o: unknown, opts: { signal: AbortSignal }) {
    stalled.signal = opts.signal
    const big = ["x".repeat(100_000)]
    if (stalled.mode === "one-big") yield big
    while (stalled.mode === "flood" && !opts.signal.aborted) {
      yield ["y".repeat(300_000)]
      await new Promise((r) => setTimeout(r, 5))
    }
    await new Promise<void>((r) => opts.signal.addEventListener("abort", () => r(), { once: true }))
  },
}))

const ctx = { params: Promise.resolve({ name: "m1" }) }
const get = (q: string, ac = new AbortController()) => import("./route").then((m) => m.GET(new Request(`http://x/api/mids/m1/logs${q}`, { signal: ac.signal }), ctx))
beforeEach(() => { vi.resetModules(); stalled.mode = "idle"; stalled.signal = undefined })

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

it("closes a client that stops reading (stalled > 10 s)", async () => {
  vi.useFakeTimers()
  try {
    stalled.mode = "one-big"
    const res = await get("?file=main")
    expect(res.status).toBe(200)
    await vi.advanceTimersByTimeAsync(5000)
    expect(stalled.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(7000)
    expect(stalled.signal?.aborted).toBe(true)
  } finally { vi.useRealTimers() }
})

it("closes a client whose queue exceeds ~1 MB immediately", async () => {
  stalled.mode = "flood"
  const res = await get("?file=main")
  expect(res.status).toBe(200)
  await vi.waitFor(() => expect(stalled.signal?.aborted).toBe(true))
})
