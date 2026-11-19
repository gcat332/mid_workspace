// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

vi.mock("next/navigation", () => ({ usePathname: () => "/" }))
vi.mock("@/lib/ui/api", async (orig) => ({ ...(await orig<typeof import("@/lib/ui/api")>()), apiFetch: vi.fn() }))

import { OverviewTab } from "./OverviewTab"
import type { MidView } from "@/lib/ui/status-view"

afterEach(cleanup)
const mid: MidView = {
  name: "spike1", instanceUrl: "https://example.service-now.com", midName: "spike1", heapMb: 1024, version: null, state: "installed",
  agentAccess: true, status: { state: "running", pid: 1, memoryBytes: 673 * 1024 * 1024, since: new Date(Date.now() - 3720_000).toISOString() },
}

describe("OverviewTab", () => {
  it("shows four tiles with the switch inside the AgentHub Access tile", () => {
    render(<OverviewTab mid={mid} />)
    const tiles = screen.getAllByTestId("overview-tile")
    expect(tiles.map((t) => t.querySelector("[data-tile-label]")?.textContent)).toEqual(["Uptime", "Memory Usage", "Version", "AgentHub Access"])
    expect(within(tiles[3]).getByRole("switch", { name: "AgentHub Access" })).toBeTruthy()
    expect(tiles[1].textContent).toContain("of 1024 MB heap")
    expect(tiles[2].textContent).toContain("Unknown")
    expect(tiles[0].textContent).toContain("1 ชม. 2 นาที")
  })

  it("keeps the definition list rows; Instance, MID Server Name and Service are mono", () => {
    const { container } = render(<OverviewTab mid={mid} />)
    const dd = (label: string) => [...container.querySelectorAll("dt")].find((d) => d.textContent === label)!.nextElementSibling as HTMLElement
    expect(dd("Instance").className).toContain("font-mono")
    expect(dd("MID Server Name").className).toContain("font-mono")
    expect(dd("Service").className).toContain("font-mono")
    expect(dd("Service").textContent).toBe("midhub-mid-spike1.service")
    expect(dd("Instance Record").textContent).toContain("Open in ServiceNow")
  })

  it("shows a dash for uptime when not running", () => {
    render(<OverviewTab mid={{ ...mid, status: { ...mid.status, state: "stopped" } }} />)
    expect(screen.getAllByTestId("overview-tile")[0].textContent).toContain("-")
  })
})
