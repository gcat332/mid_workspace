// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ChangelogView } from "./ChangelogView"

const MD = `# Changelog — Test

## Release names

- v0.2 — Second Line

## v0.2.1 — \`[bug]\`

- fixed a thing

## v0.2.0 — \`[feature]\`

- shipped it
`

let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "changelog-"))
  writeFileSync(path.join(dir, "FIXTURE.md"), MD)
  vi.spyOn(process, "cwd").mockReturnValue(dir)
})
afterAll(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
afterEach(cleanup)

describe("ChangelogView", () => {
  it("marks the newest version as Latest and shows the release name", async () => {
    render(await ChangelogView({ file: "FIXTURE.md", title: "Changelog" }))
    expect(screen.getByRole("heading", { name: "Changelog" })).toBeTruthy()
    expect(screen.getAllByText("Latest")).toHaveLength(1)
    const latest = screen.getByText("Latest").closest("article")!
    expect(latest.textContent).toContain("v0.2.1")
    expect(screen.getByText("Second Line")).toBeTruthy()
  })

  it("shows an error when the file is missing", async () => {
    render(await ChangelogView({ file: "MISSING.md", title: "Changelog" }))
    expect(screen.getByText("MISSING.md not found")).toBeTruthy()
  })
})
