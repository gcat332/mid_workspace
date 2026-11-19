// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react"

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock("@/lib/ui/api", () => ({ API_BASE: "/midhub/api", apiFetch: api.apiFetch }))

import { LogTab } from "./LogTab"

afterEach(() => { cleanup(); api.apiFetch.mockReset() })

/** An SSE body that delivers `lines` in one frame and then stays open. */
function sse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ lines })}\n\n`)) },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}
const mkLines = (n: number) => Array.from({ length: n }, (_, i) =>
  i === 199 ? "2026-11-19T13:37:38.840+0700 ERROR (Worker-1:HeartbeatProbe-1) [AWorker:190] Heartbeat failed"
    : `2026-11-19T13:37:38.840+0700 INFO  (Worker-1:x-1) [AWorker:1] line ${i + 1}`)

describe("LogTab", () => {
  it("shows the latest 150 lines with gutter numbers, levels, search marks and glossary labels", async () => {
    api.apiFetch.mockResolvedValue(sse(mkLines(200)))
    const { container } = render(<LogTab midName="m1" />)
    await waitFor(() => expect(container.querySelectorAll("[data-row]")).toHaveLength(150))
    const rows = [...container.querySelectorAll("[data-row]")]
    expect(rows[0].textContent).toContain("line 51")
    expect(rows[0].querySelector("[data-gutter]")?.textContent).toBe("1")
    expect(rows[149].querySelector("[data-gutter]")?.textContent).toBe("150")
    expect(rows[149].querySelector('[data-kind="level-error"]')?.textContent).toBe("ERROR")
    expect(screen.getByText("Showing the latest 150 lines")).toBeTruthy()

    for (const name of ["Agent Log", "Wrapper Log", "All Levels", "Pause", "Download", "Live"]) expect(screen.getByText(name)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy()
    expect(screen.getByText("Paused")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Follow" }))

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Heartbeat" } })
    const marks = container.querySelectorAll("mark")
    expect(marks.length).toBeGreaterThan(0)
    expect([...marks].every((m) => m.textContent === "Heartbeat")).toBe(true)
    expect(container.querySelector('[data-kind="thread"] mark')).toBeTruthy() // inside a coloured token
  })

  it("marks a match that spans two tokens", async () => {
    api.apiFetch.mockResolvedValue(sse(["INFO  (Worker-1) [Cls:1] done"]))
    const { container } = render(<LogTab midName="m1" />)
    await waitFor(() => expect(container.querySelectorAll("[data-row]")).toHaveLength(1))
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "INFO  (Worker" } })
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent).join("")).toBe("INFO  (Worker")
  })
})
