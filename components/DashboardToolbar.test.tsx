// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { HostView, MidView } from "@/lib/ui/status-view"
import { DashboardToolbar } from "./DashboardToolbar"

afterEach(cleanup)

const GB = 1024 ** 3
const host: HostView = {
  totalBytes: 10 * GB, availableBytes: 6 * GB, running: 1, quotaUsed: 1, maxRunning: 4,
  disk: { freeBytes: 50 * GB, totalBytes: 100 * GB, usage: { mids: GB, packages: 2 * GB, archive: 3 * GB } },
}
const mid = { name: "m1", status: { state: "running", pid: 1, memoryBytes: 1 * GB, since: null } } as MidView

describe("DashboardToolbar strip", () => {
  it("has Running, Memory (with a meter), Disk Free and Storage segments", () => {
    render(<DashboardToolbar host={host} mids={[mid]} onImport={() => {}} onCreate={() => {}} />)
    const strip = screen.getByRole("group", { name: "Host Stats" })
    for (const l of ["Running", "Memory", "Disk Free", "Storage"]) expect(strip.textContent).toContain(l)
    expect(strip.textContent).toContain("1 / 4")
    expect(strip.textContent).toContain("6.0 GB free of 10.0 GB")
    expect(strip.textContent).toContain("Packages 2.0 GB")
    const meter = screen.getByRole("meter")
    expect(meter.getAttribute("aria-valuenow")).toBe("10")
    expect(screen.getByRole("button", { name: "New MID Server" })).toBeTruthy()
    expect(screen.queryByText("Low RAM")).toBeNull()
  })

  it("shows the Low RAM pill under 1 GB free", () => {
    render(<DashboardToolbar host={{ ...host, availableBytes: GB / 2 }} mids={[]} onImport={() => {}} onCreate={() => {}} />)
    expect(screen.getByText("Low RAM")).toBeTruthy()
  })
})
