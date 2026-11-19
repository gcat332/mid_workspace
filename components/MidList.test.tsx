// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { MidView } from "@/lib/ui/status-view"
import { MidList } from "./MidList"

afterEach(cleanup)

const mk = (over: Partial<MidView> = {}): MidView => ({
  name: "m1", instanceUrl: "https://dev123.service-now.com/path", midName: "sn1", heapMb: 1024, version: null, state: "installed",
  status: { state: "running", pid: 1, memoryBytes: null, since: null }, job: null, ...over,
})

describe("MidList", () => {
  it("header counts the servers; names are mono; the host is shown without a scheme", () => {
    render(<MidList mids={[mk(), mk({ name: "m2", instanceUrl: null, agentAccess: true })]} selected="m1" onSelect={() => {}} />)
    expect(screen.getByText("MID Servers · 2")).toBeTruthy()
    expect(screen.getByText("m1").className).toContain("font-mono")
    expect(screen.getByText("dev123.service-now.com")).toBeTruthy()
    expect(screen.queryByText(/https:/)).toBeNull()
    expect(screen.getByText("No Instance")).toBeTruthy()
    expect(screen.getByText("AgentHub")).toBeTruthy()
    expect(screen.getByRole("button", { name: /^m1/ }).getAttribute("aria-current")).toBe("true")
  })
})
