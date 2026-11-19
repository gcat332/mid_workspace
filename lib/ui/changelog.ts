// Pure parsing/tree logic for the /changelog page, extracted so the
// load-bearing header regex (CLAUDE.md documents its exact shape) is testable.

export type Entry = { version: string; type: string; body: string }
// A node in the version tree. `key` is the dotted prefix (e.g. "2", "2.7", "2.7.9").
// `entry` is the release at exactly this version, or null for a pure grouping node
// (a major/minor level that has no header of its own but parents deeper releases).
export type Node = { key: string; depth: number; entry: Entry | null; children: Node[] }

// Parse "## vX.Y.Z — `[type]`" headers and the prose beneath each, up to the next
// header. Newlines are PRESERVED so the body keeps its markdown for ChangelogBody.
export function parseChangelog(md: string): Entry[] {
  const re = /^##\s+(v[\d.]+)\s+—\s+`?\[([a-zA-Z]+)\]`?\s*$/
  const entries: Entry[] = []
  let cur: Entry | null = null
  for (const line of md.split("\n")) {
    const m = re.exec(line.trim())
    if (m) {
      if (cur) entries.push(cur)
      cur = { version: m[1], type: m[2].toLowerCase(), body: "" }
    } else if (cur) {
      cur.body += line + "\n"
    }
  }
  if (cur) entries.push(cur)
  return entries.map((e) => ({ ...e, body: e.body.trim() }))
}

// Friendly titles for major/minor lines (e.g. "4.0" → "Mobile Support"), read from a
// "## Release names" section at the top of CHANGELOG.md with lines like
// "- v4.0 — Mobile Support". Keys are stored without the leading "v" to match Node.key.
export function parseVersionNames(md: string): Record<string, string> {
  const names: Record<string, string> = {}
  let inSection = false
  for (const raw of md.split("\n")) {
    const line = raw.trim()
    if (/^##\s/.test(line)) { inSection = /release names/i.test(line); continue }
    if (!inSection) continue
    const m = /^-\s+v([\d.]+)\s+[—-]\s+(.+?)\s*$/.exec(line)
    if (m) names[m[1]] = m[2].trim()
  }
  return names
}

const parts = (v: string): string[] => v.replace(/^v/, "").split(".")

// Build a full recursive version tree from the flat, newest-first entry list.
// Each version segment becomes a level: v2.7.9.4 nests as 2 › 2.7 › 2.7.9 › 2.7.9.4.
// Intermediate prefixes that never appear as their own release header (e.g. the
// major "2") still get a grouping node so their descendants have a parent. Sibling
// order follows first appearance, so the newest releases stay on top at every level.
export function buildTree(entries: Entry[]): Node[] {
  const roots: Node[] = []
  const map = new Map<string, Node>()
  const ensure = (key: string, depth: number, siblings: Node[]): Node => {
    let n = map.get(key)
    if (!n) { n = { key, depth, entry: null, children: [] }; map.set(key, n); siblings.push(n) }
    return n
  }
  for (const e of entries) {
    const segments = parts(e.version)
    let siblings = roots
    let key = ""
    let node: Node = roots[0]
    for (let i = 0; i < segments.length; i++) {
      key = i === 0 ? segments[i] : `${key}.${segments[i]}`
      node = ensure(key, i + 1, siblings)
      siblings = node.children
    }
    node.entry = e
  }
  return roots
}

// Count the actual releases (nodes with an entry) at or below a node — used for the
// "N releases" hint on collapsible grouping levels.
export function countReleases(n: Node): number {
  return (n.entry ? 1 : 0) + n.children.reduce((s, c) => s + countReleases(c), 0)
}
