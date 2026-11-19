"use client"

import dynamic from "next/dynamic"
import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { ErrorNotice, type ApiError } from "../ErrorNotice"
import { IconClose, IconDownload, IconSave } from "../icons"
import { useIsDark } from "@/lib/ui/use-is-dark"

const EDITOR_LOADING = <p className="p-3 text-sm text-gray-500 dark:text-neutral-400">Loading…</p>
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false, loading: () => EDITOR_LOADING })

const LANGS: Record<string, string> = { xml: "xml", json: "json", conf: "ini", properties: "ini", sh: "shell", js: "javascript", yaml: "yaml", yml: "yaml", md: "markdown", log: "plaintext" }
const lang = (n: string) => LANGS[n.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"

type Props = {
  midName: string
  path: string
  value: string
  readOnly: boolean
  dirty: boolean
  saved: boolean
  saving: boolean
  /** Non-null while a lifecycle job runs: shown as a banner, and saving is off. */
  busyReason: string | null
  error: ApiError | null
  downloadHref: string
  onChange: (v: string) => void
  /** Ctrl/Cmd+S and the Save button; the container decides whether there is anything to send. */
  onSave: () => void
  /** The container asks to discard unsaved changes first. */
  onClose: () => void
  /** Re-read the file after a stale (409) save. */
  onReload: () => void
  /** Set for a `config` file: leave the editor (dirty check first) and switch to the Configuration tab. */
  onOpenConfig?: () => void
}

const hdrBtn = "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-200 dark:text-neutral-300 dark:hover:bg-neutral-700"

/** Full-screen editor sheet (AgentHub's maximised editor): Monaco plus a header with status and actions. */
export function FileEditorModal(p: Props) {
  const dark = useIsDark()
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef(p.onSave)
  const pressedBackdrop = useRef(false)
  useEffect(() => { saveRef.current = p.onSave })

  // Modal behaviour: background inert, focus moves in, and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const overlay = overlayRef.current!
    const inerted = Array.from(document.body.children).filter((el) => el !== overlay && !el.hasAttribute("inert"))
    inerted.forEach((el) => el.setAttribute("inert", ""))
    dialogRef.current?.focus()
    // Capture phase, so the shortcut wins over Monaco and the browser's "Save page".
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current() }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      inerted.forEach((el) => el.removeAttribute("inert"))
      if (opener?.isConnected) opener.focus?.()
    }
  }, [])

  const canSave = !p.readOnly && p.dirty && !p.saving && !p.busyReason
  return createPortal(
    // A backdrop click closes, but only when the press also started there (not a text selection dragged out of Monaco).
    <div ref={overlayRef} className="fixed inset-0 z-[60] flex flex-col bg-black/40 backdrop-blur-sm p-2 sm:p-8"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (pressedBackdrop.current && e.target === e.currentTarget) p.onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="file-editor-title" tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col rounded-xl overflow-hidden bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl focus:outline-none">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-neutral-700 dark:bg-neutral-800">
          <h2 id="file-editor-title" className="min-w-0 flex-1 truncate font-mono text-sm text-gray-700 dark:text-neutral-200">{p.path}</h2>
          {p.dirty && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <span aria-hidden="true" className="text-amber-500">●</span>Unsaved Changes
            </span>
          )}
          {p.saved && !p.dirty && <span role="status" className="text-xs text-emerald-700 dark:text-emerald-400">Saved</span>}
          {p.readOnly && (
            <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-neutral-700 dark:text-neutral-300" title="ไฟล์นี้แก้ไขไม่ได้">Read-only</span>
          )}
          {p.onOpenConfig && <button type="button" onClick={p.onOpenConfig} className={`${hdrBtn.replace("text-gray-600 ", "")} text-blue-600 dark:text-blue-400`}>Edit in Configuration</button>}
          <a href={p.downloadHref} className={hdrBtn}><IconDownload className="h-3.5 w-3.5" />Download</a>
          {!p.readOnly && (
            <button type="button" disabled={!canSave} onClick={p.onSave} className="btn-primary inline-flex items-center gap-1 px-3 py-1 text-xs font-medium">
              <IconSave className="h-3.5 w-3.5" />{p.saving ? "Saving…" : "Save"}
            </button>
          )}
          <button type="button" onClick={p.onClose} className={hdrBtn}><IconClose className="h-3.5 w-3.5" />Close</button>
        </div>
        {p.busyReason && (
          <p role="status" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
            {p.busyReason} — แก้ไขไฟล์ไม่ได้จนกว่างานจะเสร็จ
          </p>
        )}
        {p.error && (
          <div className="shrink-0 space-y-2 border-b border-gray-200 px-4 py-2 dark:border-neutral-700">
            <ErrorNotice error={p.error} />
            {p.error.code === "stale" && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" onClick={p.onReload} className="rounded-[10px] border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-700">Reload File</button>
                <span className="text-gray-600 dark:text-neutral-400">การแก้ไขที่ยังไม่บันทึกจะหาย</span>
              </div>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <MonacoEditor theme={dark ? "vs-dark" : "vs"} height="100%" language={lang(p.path)} path={`${p.midName}/${p.path}`} value={p.value} loading={EDITOR_LOADING}
            onChange={(v) => p.onChange(v ?? "")}
            options={{ fontSize: 14, wordWrap: "on", minimap: { enabled: true }, scrollBeyondLastLine: false, automaticLayout: true, readOnly: p.readOnly }} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
