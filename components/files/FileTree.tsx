"use client"

import type { DragEvent } from "react"
import { FileIcon, FolderIcon, IconMore } from "../icons"
import { visibleRows, type TreeRow, type TreeState } from "@/lib/ui/file-tree"

export type DropHandlers = {
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}

type Props = {
  state: TreeState
  /** Highlighted row (the open file or the selected folder). */
  selected: string | null
  /** Folder currently under a file drag. */
  dragOver: string | null
  onRowClick: (row: TreeRow) => void
  /** Open the row's menu at viewport position (x, y). */
  onMenu: (row: TreeRow, x: number, y: number) => void
  /** Switch to the Configuration tab (the always-visible link on `config` rows). */
  onOpenConfig: () => void
  /** Drop handlers for a folder row (upload into that folder). */
  dropProps: (dir: string) => DropHandlers
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const pad = (depth: number) => 6 + depth * 14
const muted = "text-xs text-gray-400 dark:text-neutral-500"

/** AgentHub-style explorer rows: chevron + icon + name, metadata on sm+, and a "⋯" menu button per row. */
export function FileTree({ state, selected, dragOver, onRowClick, onMenu, onOpenConfig, dropProps }: Props) {
  const rows = visibleRows(state)
  const root = state.children[""]
  if (root === undefined || root === "loading") return <p className={`px-3 py-2 ${muted}`}>Loading…</p>
  if (!Array.isArray(root)) return null // the container shows the root error
  if (rows.length === 0) return <p className={`px-3 py-2 ${muted}`}>โฟลเดอร์ว่าง</p>

  return (
    <div className="py-1 text-sm">
      {rows.map((row) => {
        const { entry, path, depth } = row
        const isDir = entry.type === "dir"
        const open = isDir && state.expanded.has(path)
        const kids = state.children[path]
        const highlight = isDir && dragOver === path
          ? "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-inset ring-blue-500"
          : selected === path ? "bg-blue-50 dark:bg-blue-950/40" : "hover:bg-gray-100 dark:hover:bg-neutral-700"
        return (
          <div key={path}>
            <div data-row={path} style={{ paddingLeft: pad(depth) }}
              onContextMenu={(e) => { e.preventDefault(); onMenu(row, e.clientX, e.clientY) }}
              {...(isDir ? dropProps(path) : {})}
              className={`group flex items-center pr-2 ${highlight}`}>
              <button type="button" onClick={() => onRowClick(row)} aria-expanded={isDir ? open : undefined}
                className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left ${selected === path ? "font-medium text-blue-700 dark:text-blue-300" : "text-gray-700 dark:text-neutral-200"}`}>
                <span className="w-3 shrink-0 text-xs text-gray-400 dark:text-neutral-500" aria-hidden="true">{isDir ? (open ? "▾" : "▸") : ""}</span>
                {isDir ? <FolderIcon open={open} /> : <FileIcon name={entry.name} />}
                <span className="truncate">{entry.name}</span>
                {entry.readOnly && <span role="img" aria-label="Read-only" title="อ่านอย่างเดียว (แก้ไขไม่ได้)" className="shrink-0 text-xs">🔒</span>}
              </button>
              {entry.config && (
                <button type="button" onClick={onOpenConfig} title="แก้ไขไฟล์นี้ในแท็บ Configuration"
                  className="ml-1 shrink-0 whitespace-nowrap rounded px-1 text-xs text-blue-600 hover:underline dark:text-blue-400">Edit in Configuration</button>
              )}
              {!isDir && <span className={`hidden w-20 shrink-0 text-right tabular-nums sm:inline ${muted}`}>{formatSize(entry.size)}</span>}
              <span className={`hidden w-44 shrink-0 text-right tabular-nums sm:inline ${muted}`}>{entry.mtime ? new Date(entry.mtime).toLocaleString("th-TH") : ""}</span>
              <button type="button" aria-label={`More Actions: ${entry.name}`} title="More Actions" aria-haspopup="menu"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(row, r.left, r.bottom) }}
                className="ml-1 shrink-0 rounded p-0.5 text-gray-500 opacity-0 hover:bg-gray-200 hover:text-gray-800 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 dark:text-neutral-400 dark:hover:bg-neutral-600 dark:hover:text-neutral-100">
                <IconMore />
              </button>
            </div>
            {open && !(Array.isArray(kids) && kids.length > 0) && (
              <p style={{ paddingLeft: pad(depth + 1) + 17 }} className={`py-1 italic ${kids && typeof kids === "object" && "error" in kids ? "text-red-600 dark:text-red-400 not-italic text-xs" : muted}`}>
                {kids === undefined || kids === "loading" ? "Loading…" : Array.isArray(kids) ? "โฟลเดอร์ว่าง" : kids.error}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
