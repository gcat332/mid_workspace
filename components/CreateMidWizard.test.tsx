// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { CreateMidWizard } from "./CreateMidWizard"

const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }))
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.endsWith("/instances")) return json([{ id: "i1", label: "DEV", url: "https://dev.service-now.com/", midUser: "u", hasPassword: true, buildstamp: "washingtondc-12-08-2023_02-23-2024_1115", createdBy: "a", createdAt: new Date().toISOString() }])
    return json([])
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mount = (onClose = vi.fn()) => {
  render(<CreateMidWizard isAdmin userId="u1" host={null} mids={[]} jobId={null} onJobChange={() => {}} onOpenMid={() => {}} onClose={onClose} />)
  return onClose
}

describe("CreateMidWizard", () => {
  it("opens on step 1 with Next disabled and a visible reason, then enables after picking an instance", async () => {
    mount()
    expect(screen.getByRole("dialog", { name: "สร้าง MID ใหม่" })).toBeTruthy()
    const next = screen.getByRole("button", { name: "ถัดไป" }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(next.getAttribute("aria-describedby")).toBe("wizard-reason")
    expect(document.getElementById("wizard-reason")?.textContent).toMatch(/เลือก instance/)
    fireEvent.click(await screen.findByRole("radio", { name: /DEV/ }))
    expect((screen.getByRole("button", { name: "ถัดไป" }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "ถัดไป" }))
    expect(screen.getByLabelText(/ชื่อ MID \(/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "ถัดไป" }) as HTMLButtonElement).disabled).toBe(true) // no name yet
    expect(document.getElementById("wizard-reason")?.textContent).toMatch(/ตั้งชื่อ/)
  })

  it("closes straight away when nothing was entered", () => {
    const onClose = mount()
    fireEvent.click(screen.getByRole("button", { name: "ปิด" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("asks before discarding entered data; Esc closes only the confirmation", async () => {
    const onClose = mount()
    fireEvent.click(await screen.findByRole("radio", { name: /DEV/ }))
    fireEvent.click(screen.getByRole("button", { name: "ปิด" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "ปิดและทิ้งข้อมูลที่กรอก?" })).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "ปิดและทิ้งข้อมูลที่กรอก?" })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "ปิด" }))
    fireEvent.click(screen.getByRole("button", { name: "ปิดและทิ้งข้อมูล" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe("CreateMidWizard with ?job=", () => {
  class ES { onmessage = null; addEventListener() {} close() {} }
  const withJob = (kind: string) => {
    vi.stubGlobal("EventSource", ES)
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/jobs/j1")) return json({ id: "j1", kind, midName: "m1", stage: "extract", status: "running", error: null, stages: ["extract"], params: {} })
      return json([])
    }))
  }
  const show = (onClose = vi.fn()) => {
    render(<CreateMidWizard isAdmin userId="u1" host={null} mids={[]} jobId="j1" onJobChange={() => {}} onOpenMid={() => {}} onClose={onClose} />)
    return onClose
  }

  it("titles the progress modal from the job kind", async () => {
    withJob("install")
    show()
    expect(await screen.findByRole("dialog", { name: "ติดตั้ง MID" })).toBeTruthy()
    cleanup()
    withJob("clone")
    show()
    expect(await screen.findByRole("dialog", { name: "Clone MID" })).toBeTruthy()
  })

  it.each(["uninstall", "cancel_install"])("refuses a %s job: closes instead of showing it", async (kind) => {
    withJob(kind)
    const onClose = show()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
