// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { HostView, MidView } from "@/lib/ui/status-view"

vi.mock("next/navigation", () => ({ usePathname: () => "/" }))
vi.mock("./JobProgress", () => ({ JobProgress: (p: { jobId: string }) => <div data-testid="job-progress">{p.jobId}</div> }))
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
const panel = (mid: MidView, isAdmin = true, onUninstall = vi.fn()) =>
  render(<MidPanel mid={mid} host={host} isAdmin={isAdmin} onChanged={() => {}} onUninstall={onUninstall} />)

describe("MidPanel lifecycle", () => {
  it("idle admin: Start and ลบ enabled, no job panel", () => {
    const onUninstall = vi.fn()
    panel(mk(), true, onUninstall)
    expect(btn("Start").disabled).toBe(false)
    expect(btn("ลบ").disabled).toBe(false)
    expect(screen.queryByTestId("job-progress")).toBeNull()
    fireEvent.click(btn("ลบ"))
    expect(onUninstall).toHaveBeenCalledTimes(1)
  })

  it("active job: progress shown, Start/Restart/fix/ลบ disabled with the visible reason, tabs get busyReason", () => {
    panel(mk({ state: "installing", job: J("install", "extract", "running") }))
    expect(screen.getByTestId("job-progress").textContent).toBe("j1")
    for (const n of ["Start", "Restart", "ซ่อมสิทธิ์ไฟล์", "ลบ"]) expect((screen.getByRole("button", { name: n }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("มีงานกำลังทำอยู่")
    fireEvent.click(screen.getByRole("tab", { name: "ตั้งค่า" }))
    expect(screen.getByTestId("config-tab").textContent).toBe("มีงานกำลังทำอยู่")
    fireEvent.click(screen.getByRole("tab", { name: "ไฟล์" }))
    expect(screen.getByTestId("files-tab").textContent).toBe("มีงานกำลังทำอยู่")
  })

  it("active job on a running installed MID disables Stop too", () => {
    panel(mk({ status: { state: "running", pid: 1, memoryBytes: null, since: null }, job: J("install", "waitConnected", "running") }))
    expect(btn("Stop").disabled).toBe(true)
  })

  it("failed install: progress (retry/cancel live inside it) is shown, ลบ stays available to admins, tabs not blocked", () => {
    panel(mk({ state: "error", job: J("install", "extract", "failed") }))
    expect(screen.getByTestId("job-progress")).toBeTruthy()
    expect(btn("ลบ").disabled).toBe(false)
    fireEvent.click(screen.getByRole("tab", { name: "ตั้งค่า" }))
    expect(screen.getByTestId("config-tab").textContent).toBe("null")
  })

  it("an old failed job on a healthy MID shows no progress", () => {
    panel(mk({ job: J("install", "extract", "failed") }))
    expect(screen.queryByTestId("job-progress")).toBeNull()
  })

  it("member: ลบ disabled with 'ต้องเป็น Admin'", () => {
    panel(mk(), false)
    expect(btn("ลบ").disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("ต้องเป็น Admin")
  })

  it("state other than installed|error: ลบ disabled with the state reason", () => {
    panel(mk({ state: "upgrading" }))
    expect(btn("ลบ").disabled).toBe(true)
    expect(document.getElementById("mid-btn-reasons")!.textContent).toContain("ลบได้เฉพาะ MID ที่ติดตั้งเสร็จหรือมีปัญหา")
  })

  it("overview shows the latest job with a link to its progress view", () => {
    panel(mk({ job: J("install", "markRemoved", "succeeded") }))
    expect(screen.getByText(/ติดตั้ง · สำเร็จ/)).toBeTruthy()
    const a = screen.getByRole("link", { name: "ดูความคืบหน้า" }) as HTMLAnchorElement
    expect(a.getAttribute("href")).toContain("?mid=m1&job=j1")
  })
})
