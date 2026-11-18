// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Modal } from "./Modal"
import { ConfirmDialog } from "./ConfirmDialog"

afterEach(cleanup)

function Nested({ outerClose, innerClose }: { outerClose: () => void; innerClose: () => void }) {
  return (
    <Modal labelledBy="o" onClose={outerClose} wide>
      <h2 id="o">outer</h2>
      <button>outer-a</button>
      <ConfirmDialog title="inner?" confirmLabel="ยืนยัน" onConfirm={() => {}} onCancel={innerClose}>x</ConfirmDialog>
    </Modal>
  )
}

describe("nested modals", () => {
  it("Esc closes only the inner dialog", () => {
    const outer = vi.fn(), inner = vi.fn()
    render(<Nested outerClose={outer} innerClose={inner} />)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it("Tab cycles inside the inner dialog and reaches every button", () => {
    render(<Nested outerClose={() => {}} innerClose={() => {}} />)
    const inner = screen.getByRole("dialog", { name: "inner?" })
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      seen.add(document.activeElement?.textContent ?? "")
      expect(inner.contains(document.activeElement), `i=${i} active=${document.activeElement?.outerHTML}`).toBe(true)
      // jsdom has no native Tab: emulate the default move when the handler did not prevent it.
      const prevented = !fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" })
      if (!prevented) {
        const els = Array.from(inner.querySelectorAll<HTMLElement>("button")); const k = els.indexOf(document.activeElement as HTMLElement); els[k + 1]?.focus()
      }
    }
    expect(seen.has("ยกเลิก")).toBe(true)
    expect(seen.has("ยืนยัน")).toBe(true)
  })

  it("after the inner closes, the outer handles Esc again", () => {
    const outer = vi.fn()
    const { rerender } = render(<Nested outerClose={outer} innerClose={() => {}} />)
    rerender(<Modal labelledBy="o" onClose={outer}><h2 id="o">outer</h2><button>a</button></Modal>)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(outer).toHaveBeenCalledTimes(1)
  })
})
