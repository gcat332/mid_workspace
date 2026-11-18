// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ui/api", async (orig) => ({ ...(await orig<typeof import("@/lib/ui/api")>()), apiFetch }))

import { AgentAccessSwitch, AGENT_ACCESS_LABEL, AGENT_ACCESS_NOTE } from "./AgentAccessSwitch"
import { MidList } from "./MidList"
import type { MidView } from "@/lib/ui/status-view"

afterEach(() => { cleanup(); apiFetch.mockReset() })
const sw = () => screen.getByRole("switch", { name: AGENT_ACCESS_LABEL }) as HTMLButtonElement
const ok = () => new Response(JSON.stringify({ agentAccess: true }), { status: 200 })

describe("AgentAccessSwitch", () => {
  it("is an accessible switch, off by default, no note while off", () => {
    render(<AgentAccessSwitch midName="m1" enabled={false} onChanged={() => {}} />)
    expect(sw().getAttribute("aria-checked")).toBe("false")
    expect(screen.queryByText(new RegExp(AGENT_ACCESS_NOTE))).toBeNull()
  })

  it("turning on flips at once, PATCHes, shows the note, no confirm dialog", async () => {
    let release!: (r: Response) => void
    apiFetch.mockReturnValue(new Promise<Response>((r) => { release = r }))
    const onChanged = vi.fn()
    render(<AgentAccessSwitch midName="m1" enabled={false} onChanged={onChanged} />)
    fireEvent.click(sw())
    expect(sw().getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText(new RegExp(AGENT_ACCESS_NOTE))).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(apiFetch).toHaveBeenCalledWith("/mids/m1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ agentAccess: true }) }))
    release(ok())
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(sw().getAttribute("aria-checked")).toBe("true")
  })

  it("turning off sends false without confirmation", async () => {
    apiFetch.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<AgentAccessSwitch midName="m1" enabled onChanged={() => {}} />)
    fireEvent.click(sw())
    expect(sw().getAttribute("aria-checked")).toBe("false")
    expect(apiFetch).toHaveBeenCalledWith("/mids/m1", expect.objectContaining({ body: JSON.stringify({ agentAccess: false }) }))
  })

  it("reverts and shows ErrorNotice on a server error", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ code: "not_found", message: "ไม่พบ MID" }), { status: 404 }))
    render(<AgentAccessSwitch midName="m1" enabled={false} onChanged={() => {}} />)
    fireEvent.click(sw())
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toContain("ไม่พบ MID")
    expect(sw().getAttribute("aria-checked")).toBe("false")
  })

  it("reverts and shows ErrorNotice on a network failure", async () => {
    apiFetch.mockRejectedValue(new Error("down"))
    render(<AgentAccessSwitch midName="m1" enabled onChanged={() => {}} />)
    fireEvent.click(sw())
    await screen.findByRole("alert")
    expect(sw().getAttribute("aria-checked")).toBe("true")
  })

  it("is disabled with a visible reason while a job is active", () => {
    render(<AgentAccessSwitch midName="m1" enabled={false} disabledReason="มีงานกำลังทำอยู่" onChanged={() => {}} />)
    expect(sw().disabled).toBe(true)
    expect(screen.getByText("มีงานกำลังทำอยู่")).toBeTruthy()
    fireEvent.click(sw())
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe("MidList AgentHub badge", () => {
  const mk = (name: string, agentAccess: boolean): MidView => ({
    name, instanceUrl: null, midName: null, heapMb: 1024, version: null, state: "installed", agentAccess,
    status: { state: "stopped", pid: null, memoryBytes: null, since: null }, job: null,
  })
  it("shows the badge only for opted-in MIDs", () => {
    render(<MidList mids={[mk("a", true), mk("b", false)]} selected={null} onSelect={() => {}} />)
    expect(screen.getAllByText("AgentHub")).toHaveLength(1)
  })
})
