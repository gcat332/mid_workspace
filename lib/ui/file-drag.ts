import { PROTECTED_TREES } from "../mids/layout"
import type { Entry } from "./file-tree"
import { parentOf } from "./file-tree"

export const INTERNAL_MIME = "application/x-midhub-paths"

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)

/** Client-side drop rule; the server stays the authority. */
export function canMoveTo(
  paths: string[],
  target: string,
  info: { roDirs: Record<string, boolean>; entry: (p: string) => Entry | undefined; busy: boolean },
): boolean {
  if (info.busy || paths.length === 0) return false
  if (info.roDirs[target]) return false
  if (target !== "" && info.entry(target)?.symlink) return false
  if (PROTECTED_TREES.some((t) => under(target, t))) return false
  for (const p of paths) {
    if (parentOf(p) === target || under(target, p)) return false
    const e = info.entry(p)
    if (e && (e.locked || e.symlink || e.secret)) return false
  }
  return true
}

/** `base` is `/mids/<encoded name>/files` (no API_BASE), like FilesTab's other URLs. */
export function zipUrl(base: string, dir: string, names: string[], check = false): string {
  const q = new URLSearchParams({ dir })
  for (const n of names) q.append("name", n)
  if (check) q.set("check", "1")
  return `${base}/zip?${q}`
}

/** Same rules as the server's planZip. */
export function zipFilename(midName: string, dir: string, names: string[]): string {
  const uniq = [...new Set(names)]
  if (uniq.length === 1) return `${uniq[0]}.zip`
  const segs = dir.split("/").filter((s) => s !== "" && s !== ".")
  return `${segs.length ? segs[segs.length - 1] : midName}.zip`
}

/** Chrome's DownloadURL drag format ("mime:filename:url"); a ":" in the filename would break its parsing, so it becomes "_". */
export const downloadUrlData = (filename: string, absoluteUrl: string) =>
  `application/octet-stream:${filename.replaceAll(":", "_")}:${absoluteUrl}`
