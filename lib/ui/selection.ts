import { parentOf } from "./file-tree"

/** Explorer-style multi-select: all paths share one parent folder; `anchor` is the start of a shift-range. */
export type Selection = { parent: string; paths: string[]; anchor: string | null }

export const EMPTY_SELECTION: Selection = { parent: "", paths: [], anchor: null }

/** `siblings` are the display-ordered paths of `path`'s parent folder. */
export function clickSelect(
  sel: Selection,
  path: string,
  mods: { toggle: boolean; range: boolean },
  siblings: string[],
): Selection {
  const parent = parentOf(path)
  const same = sel.paths.length > 0 && sel.parent === parent
  if (mods.range && same && sel.anchor !== null) {
    const a = siblings.indexOf(sel.anchor)
    const b = siblings.indexOf(path)
    if (a >= 0 && b >= 0) return { parent, paths: siblings.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: sel.anchor }
  }
  if (mods.toggle && same) {
    const paths = sel.paths.includes(path) ? sel.paths.filter((p) => p !== path) : [...sel.paths, path]
    return { parent, paths, anchor: path }
  }
  return { parent, paths: [path], anchor: path }
}

export function selectAll(parent: string, siblings: string[]): Selection {
  return { parent, paths: [...siblings], anchor: siblings[0] ?? null }
}

/** Drops paths that no longer exist in `siblings` (after a reload). */
export function pruneSelection(sel: Selection, siblings: string[]): Selection {
  const paths = sel.paths.filter((p) => siblings.includes(p))
  if (paths.length === sel.paths.length) return sel
  return { parent: sel.parent, paths, anchor: sel.anchor !== null && paths.includes(sel.anchor) ? sel.anchor : (paths[0] ?? null) }
}
