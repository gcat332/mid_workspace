// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { JobProgress } from "./JobProgress"

class FakeES {
  static all: FakeES[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onopen: (() => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  closed = false
  constructor(public url: string) { FakeES.all.push(this) }
  addEventListener(t: string, fn: (e: MessageEvent) => void) { (this.listeners[t] ??= []).push(fn) }
  close() { this.closed = true }
  emit(entry: object) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(entry) })) }
  raw(data: string) { this.onmessage?.(new MessageEvent("message", { data })) }
  fire(t: string, data: unknown) { for (const fn of this.listeners[t] ?? []) fn(new MessageEvent(t, { data: JSON.stringify(data) })) }
}

const STAGES = ["precheck", "fetchPackage", "extract", "configure", "start", "waitConnected"]
let job: Record<string, unknown>
let calls: { url: string; method: string }[]
const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }))

beforeEach(() => {
  FakeES.all = []
  calls = []
  job = { id: "j1", kind: "install", midName: "mid-a", stage: "fetchPackage", status: "running", error: null, stages: STAGES, params: { snName: "midhub-mid-a" } }
  vi.stubGlobal("EventSource", FakeES)
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    if (url.endsWith("/jobs/j1") ) return json(job)
    if (url.endsWith("/mids")) return json([{ name: "mid-a", instanceUrl: "https://dev1.service-now.com/", midName: "midhub-mid-a & x" }])
    if (url.endsWith("/jobs/j1/cancel")) return json({ jobId: "c9" }, 202)
    if (url.endsWith("/jobs/j1/retry")) return json({ jobId: "j1" }, 202)
    return json({ message: "no" }, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const props = { jobId: "j1", onJobChange: vi.fn(), onOpenMid: vi.fn(), onClose: vi.fn(), viewer: { isAdmin: true, userId: "u1" } }
const mount = async () => {
  render(<JobProgress {...props} />)
  await screen.findByText("ดาวน์โหลดแพ็กเกจ MID")
  return FakeES.all[0]
}

describe("JobProgress", () => {
  it("opens the SSE stream and shows stages, journal lines and download percent; no retry/cancel while running", async () => {
    const es = await mount()
    expect(es.url).toBe("/midhub/api/jobs/j1/events")
    act(() => { es.emit({ type: "stage", stage: "fetchPackage" }); es.emit({ type: "log", level: "info", msg: "ดาวน์โหลด package 42%" }) })
    expect(await screen.findByText("42%")).toBeTruthy()
    expect(screen.getAllByText("ดาวน์โหลด package 42%").length).toBeGreaterThan(0)
    expect(screen.queryByText("ลองใหม่")).toBeNull()
    expect(screen.queryByText("ยกเลิกและลบ")).toBeNull()
  })

  it("renders journal text as text, never HTML", async () => {
    const es = await mount()
    act(() => es.emit({ type: "log", level: "warn", msg: "<img src=x onerror=alert(1)> MID <b>bold</b>" }))
    expect(await screen.findByText(/<img src=x/)).toBeTruthy()
    expect(document.querySelector("img")).toBeNull()
    expect(document.querySelector("b")).toBeNull()
  })

  it("on failure shows the error with retry and cancel-and-delete", async () => {
    const es = await mount()
    job = { ...job, stage: "extract", status: "failed", error: "แตกไฟล์ไม่สำเร็จ" }
    act(() => { es.emit({ type: "error", code: "x", message: "แตกไฟล์ไม่สำเร็จ", detail: "unzip: bad" }); es.fire("done", { status: "failed" }) })
    expect(await screen.findByText("ลองใหม่")).toBeTruthy()
    expect(screen.getByText("ยกเลิกและลบ")).toBeTruthy()
    expect(screen.getAllByText(/แตกไฟล์ไม่สำเร็จ/).length).toBeGreaterThan(0)
  })

  it("retry posts and reconnects", async () => {
    const es = await mount()
    job = { ...job, stage: "extract", status: "failed", error: "boom" }
    act(() => es.fire("done", { status: "failed" }))
    fireEvent.click(await screen.findByText("ลองใหม่"))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/jobs/j1/retry") && c.method === "POST")).toBe(true))
    await waitFor(() => expect(FakeES.all.length).toBe(2))
  })

  it("cancel-and-delete asks for confirmation, posts cancel, then follows the cleanup job", async () => {
    const es = await mount()
    job = { ...job, stage: "extract", status: "failed", error: "boom" }
    act(() => es.fire("done", { status: "failed" }))
    fireEvent.click(await screen.findByText("ยกเลิกและลบ"))
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(false)
    const dlg = screen.getByRole("dialog")
    fireEvent.click(Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "ยกเลิกและลบ")!)
    await waitFor(() => expect(props.onJobChange).toHaveBeenCalledWith("c9"))
  })

  it("on success links to Validate (encoded) and offers to open the MID", async () => {
    const es = await mount()
    job = { ...job, stage: "waitConnected", status: "succeeded" }
    act(() => es.fire("done", { status: "succeeded" }))
    const a = await screen.findByRole("link", { name: /Validate/ })
    expect(a.getAttribute("href")).toBe("https://dev1.service-now.com/ecc_agent_list.do?sysparm_query=name=" + encodeURIComponent("midhub-mid-a & x"))
    expect(a.getAttribute("rel")).toContain("noopener")
    fireEvent.click(screen.getByText("ไปที่ MID นี้"))
    expect(props.onOpenMid).toHaveBeenCalledWith("mid-a")
    expect(screen.queryByText("ลองใหม่")).toBeNull()
  })

  it("an SSE error event shows a notice and a reconnect button", async () => {
    const es = await mount()
    act(() => es.fire("error", { status: "error", message: "อ่านความคืบหน้าของงานไม่สำเร็จ" }))
    expect(await screen.findByText("อ่านความคืบหน้าของงานไม่สำเร็จ")).toBeTruthy()
    expect(es.closed).toBe(true)
    fireEvent.click(screen.getByText("เชื่อมต่อใหม่"))
    await waitFor(() => expect(FakeES.all.length).toBe(2))
  })

  it("closes the EventSource on unmount and when the job id changes", async () => {
    const { rerender, unmount } = render(<JobProgress {...props} />)
    await screen.findByText("ดาวน์โหลดแพ็กเกจ MID")
    const first = FakeES.all[0]
    rerender(<JobProgress {...props} key="j2" jobId="j2" />)
    expect(first.closed).toBe(true)
    const second = FakeES.all[FakeES.all.length - 1]
    expect(second.url).toContain("/jobs/j2/events")
    unmount()
    expect(second.closed).toBe(true)
  })

  it("a stale non-terminal status response never overwrites a terminal one (coalesced, out of order)", async () => {
    const es = await mount()
    const waiting: ((v: Response) => void)[] = []
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/jobs/j1")) return new Promise<Response>((r) => waiting.push(r))
      return json([])
    })
    act(() => es.emit({ type: "stage", stage: "extract" })) // starts request #1 (held)
    act(() => { es.emit({ type: "stage", stage: "configure" }); es.fire("done", { status: "failed" }) }) // coalesced into one trailing
    await waitFor(() => expect(waiting.length).toBe(1))
    await act(async () => { waiting[0](new Response(JSON.stringify({ ...job, stage: "extract", status: "running" }), { headers: { "content-type": "application/json" } })) })
    await waitFor(() => expect(waiting.length).toBe(2)) // exactly one trailing request, not three
    await act(async () => { waiting[1](new Response(JSON.stringify({ ...job, stage: "extract", status: "failed", error: "boom" }), { headers: { "content-type": "application/json" } })) })
    expect(await screen.findByText("ลองใหม่")).toBeTruthy()
    // a late stage event triggers another load that still says running: terminal state must stay
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.endsWith("/jobs/j1") ? json({ ...job, stage: "extract", status: "running" }) : json([]))
    act(() => es.emit({ type: "stage", stage: "extract" }))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByText("ลองใหม่")).toBeTruthy()
  })

  it.each(["retry", "cancel"])("a %s reply without a jobId does not navigate to job=undefined", async (which) => {
    const es = await mount()
    job = { ...job, stage: "extract", status: "failed", error: "boom" }
    act(() => es.fire("done", { status: "failed" }))
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" })
      if (url.endsWith("/retry") || url.endsWith("/cancel")) return json({}, 202)
      return json(job)
    })
    props.onJobChange.mockClear()
    if (which === "retry") fireEvent.click(await screen.findByText("ลองใหม่"))
    else {
      fireEvent.click(await screen.findByText("ยกเลิกและลบ"))
      const dlg = screen.getByRole("dialog")
      fireEvent.click(Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "ยกเลิกและลบ")!)
    }
    expect(await screen.findByText(/เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง/)).toBeTruthy()
    expect(props.onJobChange).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.url.endsWith("/jobs/j1")).length).toBeGreaterThan(1) // current job reloaded
  })

  it("loads the Validate target when a GET shows succeeded even without an SSE done event", async () => {
    job = { ...job, stage: "waitConnected", status: "succeeded" }
    render(<JobProgress {...props} />)
    expect(await screen.findByRole("link", { name: /Validate/ })).toBeTruthy()
  })

  it("shows a notice when the Validate target cannot be loaded", async () => {
    job = { ...job, stage: "waitConnected", status: "succeeded" }
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.endsWith("/jobs/j1") ? json(job) : json({ message: "no" }, 500))
    render(<JobProgress {...props} />)
    expect(await screen.findByText(/หาที่อยู่ instance/)).toBeTruthy()
  })

  it("announces stage changes in a polite live region", async () => {
    await mount()
    const live = document.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toContain("ดาวน์โหลดแพ็กเกจ MID")
  })
})

describe("JobProgress retry/cancel permissions (engine rules)", () => {
  const failed = (kind: string, createdBy: string) => { job = { ...job, kind, status: "failed", stage: "extract", error: "boom", createdBy } }
  const show = async (viewer: { isAdmin: boolean; userId: string }) => {
    render(<JobProgress {...props} viewer={viewer} />)
    await screen.findByText("boom")
  }
  const member = (userId: string) => ({ isAdmin: false, userId })

  it("removal kinds: a member sees no retry and sees 'ต้องเป็น Admin'; an admin sees retry", async () => {
    failed("uninstall", "someone")
    await show(member("m1"))
    expect(screen.queryByText("ลองใหม่")).toBeNull()
    expect(screen.getByText(/ต้องเป็น Admin/)).toBeTruthy()
    cleanup()
    failed("uninstall", "someone")
    await show({ isAdmin: true, userId: "a1" })
    expect(screen.getByText("ลองใหม่")).toBeTruthy()
  })

  it("removal kinds: even the creator (member) cannot retry cancel_install", async () => {
    failed("cancel_install", "m1")
    await show(member("m1"))
    expect(screen.queryByText("ลองใหม่")).toBeNull()
    expect(screen.getByText(/ต้องเป็น Admin/)).toBeTruthy()
  })

  it("install: the creator member sees retry and cancel", async () => {
    failed("install", "m1")
    await show(member("m1"))
    expect(screen.getByText("ลองใหม่")).toBeTruthy()
    expect(screen.getByText("ยกเลิกและลบ")).toBeTruthy()
  })

  it("install: another member sees neither and the reason 'เฉพาะผู้สร้างงานหรือ Admin'", async () => {
    failed("clone", "m1")
    await show(member("m2"))
    expect(screen.queryByText("ลองใหม่")).toBeNull()
    expect(screen.queryByText("ยกเลิกและลบ")).toBeNull()
    expect(screen.getByText(/เฉพาะผู้สร้างงานหรือ Admin/)).toBeTruthy()
  })
})
