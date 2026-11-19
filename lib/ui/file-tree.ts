/** One row of a MID directory listing, as GET /api/mids/:name/files?path= returns it. */
export type Entry = {
  name: string
  type: "file" | "dir"
  size: number
  mtime: string
  readOnly: boolean
  symlink: boolean
  locked: boolean
  secret: boolean
  config: boolean
}

/** Lazily loaded tree: `children` is keyed by dir path ("" is the MID root); `expanded` holds the open dirs. */
export type TreeState = { children: Record<string, Entry[] | "loading" | { error: string }>; expanded: Set<string> }

export type TreeRow = { path: string; depth: number; entry: Entry }

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

const byDirThenName = (a: Entry, b: Entry) =>
  a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1

/** The rows on screen, top to bottom: directories first, then by name; only expanded, loaded dirs are descended. */
export function visibleRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    const list = state.children[dir]
    if (!Array.isArray(list)) return
    for (const entry of [...list].sort(byDirThenName)) {
      const path = joinPath(dir, entry.name)
      rows.push({ path, depth, entry })
      if (entry.type === "dir" && state.expanded.has(path)) walk(path, depth + 1)
    }
  }
  walk("", 0)
  return rows
}

export function toggle(state: TreeState, path: string): TreeState {
  const expanded = new Set(state.expanded)
  if (expanded.has(path)) expanded.delete(path)
  else expanded.add(path)
  return { ...state, expanded }
}
