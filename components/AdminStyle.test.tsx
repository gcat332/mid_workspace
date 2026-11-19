// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

vi.mock("next/dynamic", () => ({ default: () => () => null }))
vi.mock("@/lib/ui/use-is-dark", () => ({ useIsDark: () => false }))
vi.mock("@/lib/ui/api", async (orig) => ({ ...(await orig<typeof import("@/lib/ui/api")>()), apiFetch: vi.fn() }))

import { apiFetch } from "@/lib/ui/api"
import { AuditLog } from "./AuditLog"
import { UsersManager } from "./UsersManager"
import { InstancesManager } from "./InstancesManager"
import { IpAllowlistManager } from "./IpAllowlistManager"
import { ConfigTab } from "./ConfigTab"

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
const mocked = vi.mocked(apiFetch)
beforeEach(() => mocked.mockReset())
afterEach(cleanup)

const RESTING = "shadow-[0_1px_2px_rgba(23,35,50,0.06)]"

describe("admin tables", () => {
  it("Audit Log: tinted header, muted 12px/500 th, mono time, card with resting shadow", async () => {
    mocked.mockImplementation(() => json({ items: [{ id: "1", at: "2026-11-19T03:00:00Z", email: "a@b.c", action: "x", midName: null, detail: "{}" }], nextCursor: null }))
    const { container } = render(<AuditLog />)
    await waitFor(() => expect(screen.getByText("2026-11-19 10:00:00")).toBeTruthy())
    expect(screen.getByText("2026-11-19 10:00:00").className).toContain("font-mono")
    const th = screen.getByRole("columnheader", { name: "Time" })
    expect(th.closest("thead")!.className).toContain("bg-gray-50")
    expect(th.closest("thead")!.className).toMatch(/text-xs font-medium/)
    const table = container.querySelector("table")!
    expect(table.className).toContain("min-w-[56rem]")
    expect(screen.getByText("x").closest("td")!.className).toContain("min-w-32")
    const card = container.querySelector("table")!.parentElement!
    expect(card.className).toContain("rounded-xl")
    expect(card.className).toContain(RESTING)
    expect(card.className).toContain("overflow-x-auto")
  })

  it("Users, Instances and IP Allowlist tables sit in a resting-shadow card with a tinted header", async () => {
    mocked.mockImplementation((p) => json(String(p).includes("ip-allowlist") ? { entries: [{ id: "1", cidr: "10.0.0.0/24", note: "", createdAt: "" }], myIp: "" } : []))
    for (const ui of [<UsersManager key="u" myId="m" />, <InstancesManager key="i" />, <IpAllowlistManager key="p" />]) {
      const { container, unmount } = render(ui)
      const table = container.querySelector("table")!
      expect(table.querySelector("thead")!.className).toContain("bg-gray-50")
      expect(table.parentElement!.className).toContain(RESTING)
      expect(table.parentElement!.className).toContain("overflow-x-auto")
      unmount()
    }
  })

  it("Instances: URL cell is mono", async () => {
    mocked.mockImplementation(() => json([{ id: "1", label: "demo", url: "https://demo.service-now.com", midUser: "u", hasPassword: true, buildstamp: null, createdBy: "", createdAt: "" }]))
    render(<InstancesManager />)
    await waitFor(() => expect(screen.getByText("https://demo.service-now.com").className).toContain("font-mono"))
  })
})

describe("Configuration form", () => {
  it("puts Save in a right-aligned action row", async () => {
    const f = { url: "https://x", username: "u", midName: "m", useProxy: false, proxyHost: "", proxyPort: "", proxyUser: "", heapMb: 1024 }
    mocked.mockImplementation((p) => json(String(p).endsWith("/backups") ? { backups: [] } : { files: { "config.xml": { content: "", hash: "a" }, "wrapper-override.conf": { content: "", hash: "b" } }, form: f }))
    render(<ConfigTab midName="m" canRestart={false} onRestart={() => {}} />)
    const save = await screen.findByRole("button", { name: "Save" })
    expect(save.parentElement!.className).toContain("justify-end")
    const label = screen.getByText("Username").closest("label")!
    expect(label.className).toContain("text-xs")
    expect(label.className).toContain("font-medium")
  })
})
