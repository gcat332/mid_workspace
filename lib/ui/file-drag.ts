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
  if (info.roDirs[target] || info.entry(target)?.readOnly) return false
  if (target !== "" && info.entry(target)?.symlink) return false
  if (PROTECTED_TREES.some((t) => under(target, t))) return false
  for (const p of paths) {
    if (parentOf(p) === target || under(target, p)) return false
    const e = info.entry(p)
    if (e && (e.locked || e.symlink || e.secret)) return false
  }
  return true
}

/** Tooltip of the "Download .zip" actions. */
export const ZIP_NOTE = "ไฟล์ config.xml ไม่ถูกรวมใน .zip"

/** The server's upload temp files (lib/mids/files.ts UPLOAD_TMP_RE); never part of a zip. */
const UPLOAD_TMP = /^\.midhub-upload-[0-9a-f]{16}\.part$/

/** Would the server's zip include this selected entry? (It skips config.xml, symlinks and upload temp files among several names.) */
export const zipIncludes = (e: Entry): boolean => !e.secret && !e.symlink && !UPLOAD_TMP.test(e.name)

/** Why nothing new can be added inside `dir` (a level-1 system/config folder), or null. Server rule: lib/mids/files.ts assertCanCreate. */
export function createBlockReason(dir: string): string | null {
  if (!PROTECTED_TREES.some((t) => under(dir, t))) return null
  return `เพิ่มไฟล์หรือโฟลเดอร์ใหม่ใน ${dir} ไม่ได้ เพราะเป็นโฟลเดอร์ระบบ/ตั้งค่าของ MID — ถ้าจะเปลี่ยนไฟล์ที่มีอยู่ ให้เปิดแก้ไขไฟล์นั้นโดยตรง`
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
