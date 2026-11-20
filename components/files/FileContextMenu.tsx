"use client"

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { ZIP_NOTE } from "@/lib/ui/file-drag"
import type { Entry } from "@/lib/ui/file-tree"

type Props = {
  x: number
  y: number
  entry: Entry
  downloadHref: string
  /** Rename/Delete are shown but disabled (a write is running or a lifecycle job holds the MID). */
  writeDisabled: boolean
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  /** Zip this folder (offered on folder rows only). */
  onZip: () => void
  /** Copy this row's MID-relative path (offered on every row). */
  onCopyPath: () => void
  onOpenConfig: () => void
  onClose: () => void
}

const item = "block w-full px-3 py-1.5 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-neutral-700 dark:focus:bg-neutral-700"
const normal = `${item} text-gray-700 dark:text-neutral-200`
const danger = `${item} text-red-600 hover:bg-red-50 focus:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 dark:focus:bg-red-950/40`

/**
 * Row menu at the pointer (or under the "⋯" button). Items follow the entry's flags: `secret` files cannot be
 * opened or downloaded, `locked` entries cannot be renamed or deleted, `config` files link to the Configuration tab.
 * Closes on Esc, an outside press, scroll or resize.
 */
export function FileContextMenu({ x, y, entry, downloadHref, writeDisabled, onOpen, onRename, onDelete, onZip, onCopyPath, onOpenConfig, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  const readable = entry.type === "file" && !entry.secret
  const isDir = entry.type === "dir"

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current!
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
  }, [x, y])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus()
    const close = () => closeRef.current()
    const onDown = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close() }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close() } }
    document.addEventListener("mousedown", onDown, true)
    document.addEventListener("touchstart", onDown, true)
    document.addEventListener("keydown", onKey)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onDown, true)
      document.removeEventListener("touchstart", onDown, true)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
      if (opener?.isConnected) opener.focus?.()
    }
  }, [])

  function onArrow(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const items = Array.from(ref.current!.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])"))
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus()
  }
  const act = (fn: () => void) => () => { onClose(); fn() }

  // Portal: a `fixed` menu inside a transformed/filtered ancestor would be positioned against that ancestor.
  return createPortal(
    <div ref={ref} role="menu" aria-label={`Actions: ${entry.name}`} onKeyDown={onArrow} style={{ left: x, top: y }}
      className="fixed z-50 min-w-44 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-xl dark:border-neutral-700 dark:bg-neutral-800">
      {readable && <button type="button" role="menuitem" className={normal} onClick={act(onOpen)}>Open</button>}
      {readable && <a role="menuitem" className={normal} href={downloadHref} onClick={onClose}>Download</a>}
      {isDir && !entry.symlink && <button type="button" role="menuitem" title={ZIP_NOTE} className={normal} onClick={act(onZip)}>Download .zip</button>}
      {entry.config && <button type="button" role="menuitem" className={normal} onClick={act(onOpenConfig)}>Edit in Configuration</button>}
      <button type="button" role="menuitem" className={normal} onClick={act(onCopyPath)}>Copy Path</button>
      {!entry.locked && <button type="button" role="menuitem" disabled={writeDisabled} className={normal} onClick={act(onRename)}>Rename</button>}
      {!entry.locked && <button type="button" role="menuitem" disabled={writeDisabled} className={danger} onClick={act(onDelete)}>Delete</button>}
    </div>,
    document.body,
  )
}
