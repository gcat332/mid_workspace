import { describe, it, expect } from "vitest"
import { parseChangelog, parseVersionNames, buildTree, countReleases } from "./changelog"

const MD = `# Changelog — Test

## Release names

- v0.4 — Mobile
- v0.4.9 — Native App Shell

## v0.4.9.1 — \`[bug]\`

**Fix a thing.**

- detail line

## v0.4.9 — \`[feature]\`

Shipped the shell.

## v0.3.0 — [chore]

No backticks around the tag.
`

describe("parseChangelog", () => {
  it("parses version, type, and markdown body (newlines preserved)", () => {
    const entries = parseChangelog(MD)
    expect(entries.map((e) => e.version)).toEqual(["v0.4.9.1", "v0.4.9", "v0.3.0"])
    expect(entries[0].type).toBe("bug")
    expect(entries[0].body).toBe("**Fix a thing.**\n\n- detail line")
  })

  it("accepts the tag with or without backticks and lowercases it", () => {
    const entries = parseChangelog(MD)
    expect(entries[2].type).toBe("chore")
    expect(parseChangelog("## v1.0 — `[SECURITY]`\n\nx")[0].type).toBe("security")
  })

  it("does not treat other ## sections (e.g. Release names) as releases", () => {
    expect(parseChangelog(MD).some((e) => e.version.includes("names"))).toBe(false)
  })

  it("ignores headers that don't match the documented shape", () => {
    // missing the em-dash separator / missing tag — the shapes CLAUDE.md warns about
    expect(parseChangelog("## v1.2.3 [bug]\n\nx")).toEqual([])
    expect(parseChangelog("## v1.2.3 — bug\n\nx")).toEqual([])
  })

  it("first parsed header is the newest (top of file = Latest)", () => {
    expect(parseChangelog(MD)[0].version).toBe("v0.4.9.1")
  })
})

describe("parseVersionNames", () => {
  it("reads '- vX.Y — Name' lines only inside the Release names section", () => {
    const names = parseVersionNames(MD)
    expect(names).toEqual({ "0.4": "Mobile", "0.4.9": "Native App Shell" })
  })

  it("stops at the next ## section", () => {
    // "- detail line" under a release must not become a name
    expect(Object.values(parseVersionNames(MD))).not.toContain("detail line")
  })
})

describe("buildTree", () => {
  const entries = parseChangelog(MD)
  const tree = buildTree(entries)

  it("nests every version segment: 0 › 0.4 › 0.4.9 › 0.4.9.1", () => {
    const root = tree.find((n) => n.key === "0")!
    const minor = root.children.find((n) => n.key === "0.4")!
    const patch = minor.children.find((n) => n.key === "0.4.9")!
    const hotfix = patch.children.find((n) => n.key === "0.4.9.1")!
    expect(hotfix.entry?.version).toBe("v0.4.9.1")
    expect(patch.entry?.version).toBe("v0.4.9")
  })

  it("creates grouping nodes for prefixes that never appear as headers", () => {
    const root = tree.find((n) => n.key === "0")!
    expect(root.entry).toBeNull()
    expect(root.children.find((n) => n.key === "0.4")!.entry).toBeNull()
  })

  it("keeps sibling order by first appearance (newest first)", () => {
    const root = tree.find((n) => n.key === "0")!
    expect(root.children.map((n) => n.key)).toEqual(["0.4", "0.3"])
  })

  it("countReleases counts only real entries, not grouping nodes", () => {
    const root = tree.find((n) => n.key === "0")!
    expect(countReleases(root)).toBe(3)
  })
})

describe("CHANGELOG.md", () => {
  it("parses, and its newest entry matches package.json's appVersion", async () => {
    const { readFile } = await import("fs/promises")
    const md = await readFile("CHANGELOG.md", "utf-8")
    const pkg = JSON.parse(await readFile("package.json", "utf-8")) as { appVersion: string }
    const entries = parseChangelog(md)
    expect(entries.length).toBeGreaterThan(1)
    expect(entries[0].version).toBe(`v${pkg.appVersion}`)
    expect(parseVersionNames(md)["0.3"]).toBe("Polish")
  })
})
