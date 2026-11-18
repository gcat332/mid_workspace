// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ConfirmDialog } from "./ConfirmDialog"

const dlg = (busy: boolean, onCancel = vi.fn()) => (
  <ConfirmDialog title="Stop m1?" confirmLabel="Stop" busy={busy} onConfirm={() => {}} onCancel={onCancel}>x</ConfirmDialog>
)

describe("ConfirmDialog", () => {
  it("is a labelled modal and focuses Cancel on open", () => {
    render(dlg(false))
    const d = screen.getByRole("dialog", { name: "Stop m1?" })
    expect(d.getAttribute("aria-modal")).toBe("true")
    expect(document.activeElement).toBe(screen.getByText("ยกเลิก"))
  })

  it("keeps focus inside the dialog when buttons become disabled (busy), and Tab does not escape", () => {
    const { rerender } = render(dlg(false))
    // Real browsers drop focus to <body> when the focused button becomes disabled; jsdom does not, so simulate it.
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    rerender(dlg(true))
    const d = screen.getByRole("dialog")
    expect(d.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(d)
    fireEvent.keyDown(document, { key: "Tab" })
    expect(d.contains(document.activeElement)).toBe(true)
  })

  it("Esc cancels unless busy", () => {
    const onCancel = vi.fn()
    const { rerender } = render(dlg(false, onCancel))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    rerender(dlg(true, onCancel))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("makes the background inert and restores focus to the opener on close", () => {
    const { rerender } = render(<><button>opener</button>{null}</>)
    const opener = screen.getByText("opener")
    opener.focus()
    rerender(<><button>opener</button>{dlg(false)}</>)
    expect(opener.closest("[inert]")).not.toBeNull()
    rerender(<><button>opener</button>{null}</>)
    expect(opener.closest("[inert]")).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
