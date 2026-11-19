// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

const monaco = vi.hoisted(() => ({ theme: "", language: "" }))
vi.mock("next/dynamic", () => ({ default: () => (p: { theme: string; language: string }) => { monaco.theme = p.theme; monaco.language = p.language; return <textarea aria-label="editor" /> } }))

import { FileEditorModal } from "./FileEditorModal"

const props = (path: string) => ({
  midName: "m1", path, value: "", readOnly: false, dirty: false, saved: false, saving: false, busyReason: null, error: null,
  downloadHref: "#", onChange: () => {}, onSave: () => {}, onClose: () => {}, onReload: () => {},
})

afterEach(() => { cleanup(); document.documentElement.classList.remove("dark") })

describe("FileEditorModal look", () => {
  it("a code file opens in the dark VS Code look even when the app is light", () => {
    render(<FileEditorModal {...props("agent/config.xml")} />)
    expect(monaco.theme).toBe("vs-dark")
    expect(monaco.language).toBe("xml")
    const dlg = screen.getByRole("dialog")
    expect(dlg.closest(".dark")).not.toBeNull()
    expect(dlg.getAttribute("data-code")).toBe("true")
  })

  it("plain text follows the app theme", () => {
    render(<FileEditorModal {...props("notes.txt")} />)
    expect(monaco.theme).toBe("vs")
    expect(monaco.language).toBe("plaintext")
    expect(screen.getByRole("dialog").closest(".dark")).toBeNull()
  })

  it.each([["deploy.ps1", "powershell"], ["run.py", "python"], ["Main.java", "java"], ["query.sql", "sql"]])("%s highlights as %s", (path, lang) => {
    render(<FileEditorModal {...props(path)} />)
    expect(monaco.language).toBe(lang)
    expect(monaco.theme).toBe("vs-dark")
  })
})
