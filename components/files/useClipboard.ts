"use client"

import { useCallback, useEffect, useRef, type RefObject } from "react"
import type { ApiError } from "../ErrorNotice"

export const COPY_FAILED: ApiError = { message: "คัดลอกไม่สำเร็จ เบราว์เซอร์ไม่อนุญาตให้เขียน clipboard ลองใหม่ หรือคัดลอกจากชื่อในเมนูแทน" }
export const FOLDER_NOTE = "วางโฟลเดอร์ไม่ได้ — ลากไฟล์มาวางแทน หรือบีบเป็น .zip แล้ววางไฟล์ .zip"

type Deps = {
  /** The Files card: a paste is taken only when focus is inside it or on <body>. */
  cardRef: RefObject<HTMLElement | null>
  /** False while the editor, a dialog or the menu is open. */
  canPaste: () => boolean
  upload: (files: File[], note?: string) => void
  setNote: (n: string | null) => void
  setErr: (e: ApiError | null) => void
}

/** Pasted entries that are folders: by webkitGetAsEntry when the browser offers it, else by the "empty, typeless, dotless file" look. */
export function splitPasted(data: DataTransfer): { files: File[]; folders: number } {
  const items = Array.from(data.items ?? []).filter((i) => i.kind === "file")
  if (items.length > 0 && items.every((i) => typeof i.webkitGetAsEntry === "function")) {
    const files: File[] = []
    let folders = 0
    for (const i of items) {
      if (i.webkitGetAsEntry()?.isDirectory) { folders++; continue }
      const f = i.getAsFile()
      if (f) files.push(f)
    }
    return { files, folders }
  }
  const all = Array.from(data.files ?? [])
  const files = all.filter((f) => !(f.size === 0 && f.type === "" && !f.name.includes(".")))
  return { files, folders: all.length - files.length }
}

/** Copy Path (clipboard write) and the page-level paste-to-upload listener. */
export function useClipboard(d: Deps) {
  const ref = useRef(d)
  useEffect(() => { ref.current = d })

  const copyPaths = useCallback(async (paths: string[]) => {
    const { setNote, setErr } = ref.current
    try {
      await navigator.clipboard.writeText(paths.join("\n"))
      setErr(null); setNote(`คัดลอก path แล้ว (${paths.length} รายการ)`)
    } catch {
      setNote(null); setErr(COPY_FAILED)
    }
  }, [])

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const data = e.clipboardData
      if (!data || !(data.files?.length > 0)) return
      const { cardRef, canPaste, upload, setNote } = ref.current
      const t = e.target instanceof Element ? e.target : document.body
      if (!canPaste() || t.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu]")) return
      if (t !== document.body && t !== document.documentElement && !cardRef.current?.contains(t)) return
      e.preventDefault()
      const { files, folders } = splitPasted(data)
      if (files.length > 0) upload(files, folders > 0 ? FOLDER_NOTE : undefined)
      else setNote(FOLDER_NOTE)
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [])

  return { copyPaths }
}
