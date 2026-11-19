// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { StatusDot, StatusPill } from "./StatusPill"

describe("StatusPill", () => {
  it("shows the label and a data-tone attribute", () => {
    render(<StatusPill view={{ tone: "failed", label: "Install Failed" }} />)
    const pill = screen.getByText("Install Failed")
    expect(pill.getAttribute("data-tone")).toBe("failed")
  })
  it("pulses the dot when busy only", () => {
    const { container, rerender } = render(<StatusPill view={{ tone: "busy", label: "Working" }} />)
    expect(container.querySelector("[aria-hidden]")!.className).toContain("animate-pulse")
    rerender(<StatusPill view={{ tone: "running", label: "Running" }} />)
    expect(container.querySelector("[aria-hidden]")!.className).not.toContain("animate-pulse")
  })
  it("StatusDot is aria-hidden", () => {
    const { container } = render(<StatusDot tone="stopped" />)
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true")
  })
  it("no component source contains status emoji", () => {
    const dir = __dirname
    for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes(".test."))) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/[🟢⚪🟡🔴]/u)
    }
  })
})
