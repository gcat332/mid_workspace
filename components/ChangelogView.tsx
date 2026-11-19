import { readFile } from "fs/promises"
import path from "path"
import { ChangelogBody } from "@/components/ChangelogBody"
import {
  parseChangelog, parseVersionNames, buildTree, countReleases,
  type Entry, type Node,
} from "@/lib/ui/changelog"
import type { ReactNode } from "react"
import { cardCls } from "@/lib/ui/classes"

// MidHub has no shared Badge module, so the tone palette and pill live here (values copied from AgentHub's Badge).
const TONES = {
  gray:   { badge: "bg-gray-100 text-gray-600 dark:bg-neutral-700 dark:text-neutral-300", dot: "bg-gray-400 dark:bg-neutral-400" },
  blue:   { badge: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300", dot: "bg-blue-600 dark:bg-blue-400" },
  red:    { badge: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300", dot: "bg-red-500" },
  amber:  { badge: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300", dot: "bg-amber-500" },
  purple: { badge: "bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300", dot: "bg-purple-500" },
} as const
type Tone = keyof typeof TONES

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone].badge}`}>
      {children}
    </span>
  )
}

type Style = { label: string; icon: string; tone: Tone }
const TAG_STYLE: Record<string, Style> = {
  feature:  { label: "Feature",  icon: "✨", tone: "blue" },
  bug:      { label: "Bug Fix",  icon: "🐛", tone: "amber" },
  style:    { label: "Style",    icon: "🎨", tone: "purple" },
  security: { label: "Security", icon: "🔒", tone: "red" },
  chore:    { label: "Chore",    icon: "🔧", tone: "gray" },
}
const FALLBACK: Style = { label: "Update", icon: "•", tone: "gray" }
const styleFor = (t: string): Style => TAG_STYLE[t] ?? FALLBACK

function VersionCard({ entry, latest }: { entry: Entry; latest?: boolean }) {
  const s = styleFor(entry.type)
  return (
    <article className={`${cardCls} px-4 py-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-[15px] font-semibold text-gray-900 dark:text-neutral-100">{entry.version}</h3>
        <Badge tone={s.tone}>
          <span>{s.icon}</span>{s.label}
        </Badge>
        {latest && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Latest</span>
        )}
      </div>
      {entry.body && <ChangelogBody body={entry.body} />}
    </article>
  )
}

// Header for a pure grouping level (a major/minor prefix with no release of its own).
// Sizing scales down with depth so the tree reads as a hierarchy at a glance.
function GroupHeader({ node, name }: { node: Node; name?: string }) {
  const size = node.depth === 1 ? "text-[15px] font-bold" : "text-[13px] font-semibold"
  const tier = ["major", "minor", "patch"][node.depth - 1] ?? "release"
  return (
    <div className="px-1 py-1">
      <h2 className={`flex flex-wrap items-baseline gap-x-2 font-mono text-gray-700 dark:text-neutral-200 ${size}`}>
        <span>v{node.key}</span>
        {name && <span className="font-sans font-semibold text-gray-800 dark:text-neutral-100">{name}</span>}
        <span className="font-sans text-xs font-normal text-gray-400 dark:text-neutral-500">{tier}</span>
      </h2>
    </div>
  )
}

// Render one tree node and, recursively, its descendants. A node either shows a real
// release card (when it has an entry) or a grouping header; either way its children
// hang below in a collapsible, indented list.
function VersionNode({ node, latestVersion, versionNames, top }: { node: Node; latestVersion?: string; versionNames: Record<string, string>; top?: boolean }) {
  const dot = node.entry ? TONES[styleFor(node.entry.type).tone].dot : "bg-gray-300 dark:bg-neutral-600"
  const dotOffset = top ? "-left-[2.05rem]" : "-left-[1.4rem]"
  const dotSize = top ? "h-3 w-3 ring-4" : "h-2 w-2 ring-2"
  return (
    <li className="relative">
      <span className={`absolute top-4 rounded-full ring-gray-50 dark:ring-neutral-900 ${dot} ${dotOffset} ${dotSize}`} />
      {node.entry
        ? <VersionCard entry={node.entry} latest={node.entry.version === latestVersion} />
        : <GroupHeader node={node} name={versionNames[node.key]} />}

      {node.children.length > 0 && (
        <details open className="group/sub mt-2 ml-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300">
            <span className="transition-transform group-open/sub:rotate-90">▸</span>
            {countReleases(node)} release{countReleases(node) > 1 ? "s" : ""}
            <span className="font-mono text-gray-400 dark:text-neutral-600">under v{node.key}</span>
          </summary>
          <ol className="mt-1 space-y-2.5 border-l border-dashed border-gray-300 pl-5 dark:border-neutral-600">
            {node.children.map((c) => (
              <VersionNode key={c.key} node={c} latestVersion={latestVersion} versionNames={versionNames} />
            ))}
          </ol>
        </details>
      )}
    </li>
  )
}

// Render a CHANGELOG.md (path relative to the repo root) as the version-tree page. Read at
// request time so it always reflects the committed file — no rebuild needed when it changes.
export async function ChangelogView({ file, title }: { file: string; title: string }) {
  let tree: Node[] = []
  let latestVersion: string | undefined
  let versionNames: Record<string, string> = {}
  let error: string | null = null
  try {
    const md = await readFile(path.join(process.cwd(), file), "utf-8")
    const entries = parseChangelog(md)
    latestVersion = entries[0]?.version
    versionNames = parseVersionNames(md)
    tree = buildTree(entries)
  } catch {
    error = `${file} not found`
  }

  return (
    <div className="bg-gray-50/60 dark:bg-neutral-900">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-neutral-50">{title}</h1>
            {latestVersion && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-2.5 py-0.5 font-mono text-xs font-semibold text-white shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-white/80" />{latestVersion}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-gray-500 dark:text-neutral-400">
            History of{" "}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">{file}</code>
            <span className="text-gray-400 dark:text-neutral-500"> · nested by version — major › minor › patch</span>
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(TAG_STYLE).map(([key, s]) => (
              <Badge key={key} tone={s.tone}>
                <span>{s.icon}</span>{s.label}
              </Badge>
            ))}
          </div>
        </header>

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : (
          <ol className="relative space-y-6 border-l border-gray-200 pl-7 dark:border-neutral-700">
            {tree.map((n) => (
              <VersionNode key={n.key} node={n} latestVersion={latestVersion} versionNames={versionNames} top />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}
