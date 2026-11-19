// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { HostView, MidView } from "@/lib/ui/status-view"

vi.mock("next/navigation", () => ({ usePathname: () => "/" }))
vi.mock("./JobProgress", () => ({
  JobProgress: (p: { jobId: string; onClose: () => void }) => <div data-testid="job-progress">{p.jobId}<button onClick={p.onClose}>close-progress</button></div>,
}))
vi.mock("./ConfigTab", () => ({ ConfigTab: (p: { busyReason?: string | null }) => <div data-testid="config-tab">{String(p.busyReason)}</div> }))
vi.mock("./FilesTab", () => ({ FilesTab: (p: { busyReason?: string | null }) => <div data-testid="files-tab">{String(p.busyReason)}</div> }))

import { MidPanel } from "./MidPanel"

afterEach(cleanup)

const host: HostView = { totalBytes: 1, availableBytes: 1, running: 0, quotaUsed: 0, maxRunning: 4 }
const mk = (over: Partial<MidView> = {}): MidView => ({
  name: "m1", instanceUrl: "https://d.service-now.com", midName: "sn1", heapMb: 1024, version: null, state: "installed",
  status: { state: "stopped", pid: null, memoryBytes: null, since: null }, job: null, ...over,
})
const J = (kind: string, stage: string, status: string) => ({ id: "j1", kind, stage, status, createdAt: "2026-11-18T05:00:00.000Z" })
const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement
type Extra = { jobOwnedElsewhere?: boolean; optimisticBusy?: boolean }
const panel = (mid: MidView, isAdmin = true, onUninstall = vi.fn(), extra: Extra = {}) =>
  render(<MidPanel userId="u1" mid={mid} host={host} isAdmin={isAdmin} onChanged={() => {}} onUninstall={onUninstall} {...extra} />)

describe("MidPanel lifecycle", () => {
  it("idle admin: Start and Uninstall enabled, no job panel", () => {
    const onUninstall = vi.fn()
    panel(mk(), true, onUninstall)
    expect(btn("Start").disabled).toBe(false)
    expect(btn("Uninstall").disabled).toBe(false)
    expect(screen.queryByTestId("job-progress")).toBeNull()
    fireEvent.click(btn("Uninstall"))
    expect(onUninstall).toHaveBeenCalledTimes(1)
  })

  it("active job: progress shown, Start/Restart/fix/Uninstall disabled with the visible reason, tabs get busyReason", () => {
    panel(mk({ state: "installing", job: J("install", "extract", "running") }))
    expect(screen.getByTestId("job-progress").textContent).toContain("j1")
    for (const n of ["Start", "Restart", "Repair Permissions", "Uninstall"]) expect((screen.getByRole("button", { name: n }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("มีงานกำลังทำอยู่")
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }))
    expect(screen.getByTestId("config-tab").textContent).toBe("มีงานกำลังทำอยู่")
    fireEvent.click(screen.getByRole("tab", { name: "Files" }))
    expect(screen.getByTestId("files-tab").textContent).toBe("มีงานกำลังทำอยู่")
  })

  it("active job on a running installed MID disables Stop too", () => {
    panel(mk({ status: { state: "running", pid: 1, memoryBytes: null, since: null }, job: J("install", "waitConnected", "running") }))
    expect(btn("Stop").disabled).toBe(true)
  })

  it("failed install: progress (retry/cancel live inside it) is shown, Uninstall stays available to admins, tabs not blocked", () => {
    panel(mk({ state: "error", job: J("install", "extract", "failed") }))
    expect(screen.getByTestId("job-progress")).toBeTruthy()
    expect(btn("Uninstall").disabled).toBe(false)
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }))
    expect(screen.getByTestId("config-tab").textContent).toBe("null")
  })

  it("a server-side lifecycle refusal (409 job_active, e.g. Start on an `error` MID) is shown in ErrorNotice", async () => {
    const msg = "MID นี้ยังไม่พร้อมใช้งาน (ผิดพลาด) รอให้เสร็จหรือให้ Admin ตรวจสอบก่อน"
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "job_active", message: msg }, { status: 409 })))
    try {
      panel(mk({ state: "error", job: J("install", "waitConnected", "failed") }))
      fireEvent.click(btn("Start"))
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(msg))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("an old failed job on a healthy MID shows no progress", () => {
    panel(mk({ job: J("install", "extract", "failed") }))
    expect(screen.queryByTestId("job-progress")).toBeNull()
  })

  it("member: Uninstall disabled with 'ต้องเป็น Admin'", () => {
    panel(mk(), false)
    expect(btn("Uninstall").disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("ต้องเป็น Admin")
  })

  it("state other than installed|error: Uninstall disabled with the state reason", () => {
    panel(mk({ state: "upgrading" }))
    expect(btn("Uninstall").disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("ลบได้เฉพาะ MID ที่ติดตั้งเสร็จหรือมีปัญหา")
  })

  it("overview shows the latest job with a link to its progress view", () => {
    panel(mk({ job: J("install", "markRemoved", "succeeded") }))
    expect(screen.getByText(/Install · Succeeded/)).toBeTruthy()
    const a = screen.getByRole("link", { name: "View Progress" }) as HTMLAnchorElement
    expect(a.getAttribute("href")).toContain("?mid=m1&job=j1")
  })

  it.each(["uninstall", "cancel_install"])("%s job active: progress shown, writes blocked, no overview link", (kind) => {
    panel(mk({ state: "uninstalling", job: J(kind, "archive", "running") }))
    expect(screen.getByTestId("job-progress")).toBeTruthy()
    expect(btn("Start").disabled).toBe(true)
    expect(btn("Uninstall").disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("มีงานกำลังทำอยู่")
    expect(screen.queryByRole("link", { name: "View Progress" })).toBeNull()
  })

  it.each(["uninstall", "cancel_install"])("%s job failed: progress shown, tabs blocked with the retry/cancel wording, no link", (kind) => {
    panel(mk({ state: "uninstalling", job: J(kind, "archive", "failed") }))
    expect(screen.getByTestId("job-progress")).toBeTruthy()
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("งานล้มเหลว — ลองใหม่หรือยกเลิกด้านล่าง")
    fireEvent.click(screen.getByRole("tab", { name: "Files" }))
    expect(screen.getByTestId("files-tab").textContent).toBe("งานล้มเหลว — ลองใหม่หรือยกเลิกด้านล่าง")
    expect(screen.queryByRole("link", { name: "View Progress" })).toBeNull()
  })

  it("a failed install in a transitional state uses the failed wording, an active one the busy wording", () => {
    panel(mk({ state: "installing", job: J("install", "extract", "failed") }))
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("งานล้มเหลว")
    expect(document.getElementById("mid-btn-reasons")!.textContent).not.toContain("มีงานกำลังทำอยู่")
  })

  it("jobOwnedElsewhere hides the panel's own progress but still blocks writes", () => {
    panel(mk({ state: "uninstalling", job: J("uninstall", "archive", "running") }), true, vi.fn(), { jobOwnedElsewhere: true })
    expect(screen.queryByTestId("job-progress")).toBeNull()
    expect(btn("Start").disabled).toBe(true)
  })

  it("optimisticBusy blocks writes before the poll reports the job", () => {
    panel(mk(), true, vi.fn(), { optimisticBusy: true })
    expect(btn("Start").disabled).toBe(true)
    expect(btn("Uninstall").disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("มีงานกำลังทำอยู่")
  })

  it("progress stays after the job ends (watched) until dismissed with onClose", () => {
    const { rerender } = panel(mk({ state: "installing", job: J("install", "extract", "running") }))
    const done = mk({ job: J("install", "markRemoved", "succeeded") })
    rerender(<MidPanel userId="u1" mid={done} host={host} isAdmin onChanged={() => {}} onUninstall={() => {}} />)
    expect(screen.getByTestId("job-progress")).toBeTruthy()
    fireEvent.click(screen.getByText("close-progress"))
    expect(screen.queryByTestId("job-progress")).toBeNull()
  })

  it("overview link: only for install/clone jobs that the panel does not already show", () => {
    panel(mk({ job: J("clone", "markRemoved", "succeeded") }))
    expect(screen.getByRole("link", { name: "View Progress" })).toBeTruthy()
    cleanup()
    panel(mk({ state: "error", job: J("install", "extract", "failed") })) // shown in the panel already
    expect(screen.queryByRole("link", { name: "View Progress" })).toBeNull()
  })
})
