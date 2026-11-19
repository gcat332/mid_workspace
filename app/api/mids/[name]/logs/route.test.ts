import { beforeEach, expect, it, vi } from "vitest"

const session = vi.hoisted(() => ({ valid: true, tokens: [] as (string | undefined)[] }))
vi.mock("@/lib/auth/helpers", () => ({
  requireUser: vi.fn(async () => ({ userId: "u1" })),
  userFromToken: vi.fn(async (t: string | undefined) => { session.tokens.push(t); return session.valid ? { userId: "u1" } : null }),
}))
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "midhub_session" ? { value: "tok" } : undefined) }) }))
vi.mock("@/lib/mids/registry", () => ({ getMid: vi.fn(async () => ({})) }))
vi.mock("@/lib/mids/files", () => ({ isLogKey: (k: string) => k === "main" || k === "wrapper", openLog: vi.fn(async () => async () => ({ h: { close: async () => {} }, st: {} })), openDownload: vi.fn() }))
const stalled = vi.hoisted(() => ({ mode: "idle" as "idle" | "one-big" | "flood" | "replay" | "replay-big", signal: undefined as AbortSignal | undefined }))
vi.mock("@/lib/mids/log-tail", () => ({
  // idle: never yields; one-big: one 100 KB batch; flood: 300 KB batches. Ends when aborted.
  // replay: a 1,000-line initial window in two batches, then onCaughtUp, then one appended line.
  tailFile: async function* (_o: unknown, opts: { signal: AbortSignal; onCaughtUp?: () => void | Promise<void> }) {
    stalled.signal = opts.signal
    if (stalled.mode === "replay-big") {
      yield Array.from({ length: 150 }, (_, i) => `${String(i).padStart(3, "0")}${"z".repeat(16 * 1024 - 3)}`)
      await opts.onCaughtUp?.()
      yield ["appended"]
    }
    if (stalled.mode === "replay") {
      const all = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`)
      yield all.slice(0, 400)
      yield all.slice(400)
      await opts.onCaughtUp?.()
      yield ["appended"]
    }
    const big = ["x".repeat(100_000)]
    if (stalled.mode === "one-big") yield big
    await opts.onCaughtUp?.() // the (real) initial window is over; everything after this streams unbuffered
    while (stalled.mode === "flood" && !opts.signal.aborted) {
      yield ["y".repeat(300_000)]
      await new Promise((r) => setTimeout(r, 5))
    }
    await new Promise<void>((r) => opts.signal.addEventListener("abort", () => r(), { once: true }))
  },
}))

const ctx = { params: Promise.resolve({ name: "m1" }) }
const get = (q: string, ac = new AbortController()) => import("./route").then((m) => m.GET(new Request(`http://x/api/mids/m1/logs${q}`, { signal: ac.signal }), ctx))
beforeEach(() => { vi.resetModules(); stalled.mode = "idle"; stalled.signal = undefined; session.valid = true; session.tokens = [] })

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

it("does not cut a slow-but-healthy client while the paced initial frames drain (stall timer resets)", async () => {
  vi.useFakeTimers()
  try {
    stalled.mode = "replay-big"
    const res = await get("?file=main")
    const rd = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(6000)
      await rd.read() // one read every 6 s: slow, but always draining
      expect(stalled.signal?.aborted).toBe(false)
    }
    await rd.cancel().catch(() => {})
  } finally { vi.useRealTimers() }
})

it("closes a client whose queue exceeds ~1 MB immediately", async () => {
  stalled.mode = "flood"
  const res = await get("?file=main")
  expect(res.status).toBe(200)
  await vi.waitFor(() => expect(stalled.signal?.aborted).toBe(true))
})

it("re-checks the session every ~60 s and closes the stream once it is revoked (M9)", async () => {
  vi.useFakeTimers()
  try {
    const res = await get("?file=main")
    expect(res.status).toBe(200)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(session.tokens).toEqual(["tok"]) // the cookie captured at connect time
    expect(stalled.signal?.aborted).toBe(false)
    session.valid = false // e.g. user locked, deleted or password reset by an admin
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stalled.signal?.aborted).toBe(true)
  } finally { vi.useRealTimers() }
})

it("sends only the last 150 lines of the initial window as the first frame, then streams later lines", async () => {
  stalled.mode = "replay"
  const ac = new AbortController()
  const res = await get("?file=main", ac)
  const rd = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let text = ""
  while (!text.includes("appended")) { const { done, value } = await rd.read(); if (done) break; text += value }
  const frames = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]) as { lines: string[] })
  expect(frames).toHaveLength(2)
  expect(frames[0].lines).toHaveLength(150)
  expect(frames[0].lines[0]).toBe("line 851")
  expect(frames[0].lines.at(-1)).toBe("line 1000")
  expect(frames[1].lines).toEqual(["appended"])
  ac.abort()
  await rd.cancel().catch(() => {})
})

it("a 150 x 16 KiB initial window is split into frames, not aborted, and arrives complete and in order", async () => {
  stalled.mode = "replay-big"
  const ac = new AbortController()
  const res = await get("?file=main", ac)
  const rd = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let text = ""
  while (!text.includes("appended")) { const { done, value } = await rd.read(); if (done) break; text += value }
  expect(stalled.signal?.aborted).toBe(false)
  const frames = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]) as { lines: string[] })
  expect(frames.length).toBeGreaterThan(2)
  expect(frames.slice(0, -1).every((f) => f.lines.join("").length <= 220 * 1024)).toBe(true)
  const initial = frames.slice(0, -1).flatMap((f) => f.lines)
  expect(initial).toHaveLength(150)
  expect(initial.map((l) => l.slice(0, 3))).toEqual(Array.from({ length: 150 }, (_, i) => String(i).padStart(3, "0")))
  ac.abort()
  await rd.cancel().catch(() => {})
})
