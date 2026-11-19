// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { MidView } from "@/lib/ui/status-view"

let search = "mid=demo-x"
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock("./AppChrome", () => ({ AppChrome: (p: { children: React.ReactNode }) => <div>{p.children}</div> }))
vi.mock("./DashboardToolbar", () => ({ DashboardToolbar: () => null }))
vi.mock("./ImportMidDialog", () => ({ ImportMidDialog: () => null }))
vi.mock("./ConfigTab", () => ({ ConfigTab: () => null }))
vi.mock("./FilesTab", () => ({ FilesTab: () => null }))
vi.mock("./CreateMidWizard", () => ({
  CreateMidWizard: (p: { onStarted?: (n: string) => void }) => <button onClick={() => p.onStarted?.("demo-x")}>wizard-started</button>,
}))
vi.mock("./JobProgress", () => ({
  JobProgress: (p: { jobId: string }) => <div data-testid="job-progress">{p.jobId}</div>,
}))

import { Dashboard } from "./Dashboard"

const J = (kind: string, status: string) => ({ id: "u1", kind, stage: "archive", status, createdAt: "2026-11-18T05:00:00.000Z" })
const mk = (state: string, job: MidView["job"]): MidView => ({
  name: "demo-x", instanceUrl: "https://d.service-now.com", midName: "sn-x", heapMb: 1024, version: null, state,
  status: { state: "stopped", pid: null, memoryBytes: null, since: null }, job,
})
let mids: MidView[]
const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }))

beforeEach(() => {
  vi.useFakeTimers()
  search = "mid=demo-x"
  try { sessionStorage.clear() } catch { /* ignore */ }
  vi.stubGlobal("matchMedia", () => ({ matches: false }))
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.endsWith("/mids")) return json(mids)
    if (url.endsWith("/host")) return json({ totalBytes: 1, availableBytes: 1, running: 0, quotaUsed: 0, maxRunning: 4 })
    return json({})
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const load = async (isAdmin = true) => { render(<Dashboard email="a@b" userId="u1" isAdmin={isAdmin} />); await act(async () => { await vi.advanceTimersByTimeAsync(50) }) }
const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5100) }) }

describe("Dashboard uninstall ownership", () => {
  it("an in-flight uninstall on load opens the dialog in resume mode with a single progress view", async () => {
    mids = [mk("uninstalling", J("uninstall", "running"))]
    await load()
    expect(screen.getByRole("dialog", { name: "ลบ demo-x" })).toBeTruthy()
    expect(screen.queryByLabelText(/พิมพ์ชื่อ MID/)).toBeNull()
    expect(screen.getAllByTestId("job-progress")).toHaveLength(1) // the dialog's; the panel hides its own
  })

  it("a failed uninstall is resumed too; an install job is not", async () => {
    mids = [mk("uninstalling", J("uninstall", "failed"))]
    await load()
    expect(screen.getByRole("dialog")).toBeTruthy()
    cleanup()
    mids = [mk("installing", J("install", "running"))]
    await load()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("dismissing the resumed dialog keeps it closed across polls and the panel shows its own progress again", async () => {
    mids = [mk("uninstalling", J("uninstall", "running"))]
    await load()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
    await poll(); await poll()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(JSON.parse(sessionStorage.getItem("midhub.uninstall.dismissed")!)).toContain("u1")
    expect(screen.getAllByTestId("job-progress")).toHaveLength(1)
  })

  it("a failed uninstall whose MID is no longer 'uninstalling' is not resumed", async () => {
    mids = [mk("installed", J("uninstall", "failed"))]
    await load()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("a member also gets the resumed dialog (retry gating lives in JobProgress)", async () => {
    mids = [mk("uninstalling", J("uninstall", "failed"))]
    await load(false)
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("stays closed across polls even when sessionStorage throws", async () => {
    mids = [mk("uninstalling", J("uninstall", "running"))]
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    await load()
    fireEvent.keyDown(document, { key: "Escape" })
    await poll()
    expect(screen.queryByRole("dialog")).toBeNull()
    vi.restoreAllMocks()
  })
})

describe("Dashboard optimistic busy", () => {
  it("a created job blocks the MID's writes right away, before a poll reports the job", async () => {
    search = "mid=demo-x&create=1"
    mids = [mk("installed", null)]
    await load()
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false)
    mids = [mk("installed", null)] // the next poll lags
    fireEvent.click(screen.getByText("wizard-started"))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("is cleared once a poll shows the job finished (latest job changed, not active), so writes unlock", async () => {
    search = "mid=demo-x&create=1"
    mids = [mk("installed", null)]
    await load()
    mids = [mk("installed", null)]
    fireEvent.click(screen.getByText("wizard-started"))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true)
    mids = [mk("installed", J("install", "succeeded"))] // finished between polls: never seen active
    await poll()
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("is cleared when the MID is no longer listed", async () => {
    search = "mid=demo-x&create=1"
    mids = [mk("installed", null)]
    await load()
    fireEvent.click(screen.getByText("wizard-started"))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    mids = [{ ...mk("installed", null), name: "other" }] // demo-x vanished
    await poll()
    mids = [mk("installed", null)] // reappears idle
    await poll()
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("uses the full page width (no max-w-6xl / mx-auto) with nav-aligned padding", async () => {
    mids = [mk("installed", null)]
    await load()
    const main = document.querySelector("main")!
    expect(main.className).not.toContain("max-w-6xl")
    expect(main.className).not.toContain("mx-auto")
    expect(main.className).toContain("md:px-8")
  })
})
