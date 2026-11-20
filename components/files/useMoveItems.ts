"use client"

import { useRef, useState } from "react"
import { readApiError, type ApiError } from "../ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { joinPath as join, parentOf } from "@/lib/ui/file-tree"

type Answer = "replace" | "skip" | "cancel"
type Deps = {
  base: string
  busy: boolean
  setBusy: (b: boolean) => void
  setErr: (e: ApiError | null) => void
  network: ApiError
  load: (dir: string) => Promise<unknown>
  forget: (path: string) => void
  clearSelection: () => void
  /** Path of the file open in the editor, if any. */
  openPath: string | null
  /** The open file was moved to `to`: the container closes the editor and shows the note. */
  onOpenMoved: (to: string) => void
}

const baseName = (p: string) => p.split("/").pop() ?? p
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)

/** Sequential move of paths into a folder, asking Replace/Skip per file-over-file clash. The first other error stops the rest. */
export function useMoveItems(d: Deps) {
  const [conflict, setConflict] = useState<string | null>(null)
  const answerRef = useRef<((a: Answer, all: boolean) => void) | null>(null)

  const ask = (name: string) => new Promise<{ a: Answer; all: boolean }>((resolve) => {
    answerRef.current = (a, all) => resolve({ a, all })
    setConflict(name)
  })
  const answer = (a: Answer, all = false) => { answerRef.current?.(a, all); answerRef.current = null; setConflict(null) }

  async function move(paths: string[], dir: string) {
    if (paths.length === 0 || d.busy) return
    d.setBusy(true); d.setErr(null)
    let done = 0
    let failure: ApiError | null = null
    let failedName = ""
    let always: Answer | null = null
    try {
      outer: for (const p of paths) {
        failedName = baseName(p)
        for (let overwrite = false; ;) {
          const res = await apiFetch(d.base, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "move", path: p, to: dir, ...(overwrite ? { overwrite: true } : {}) }),
          })
          if (res.ok) {
            const open = d.openPath
            d.forget(p); done++
            if (open && under(open, p)) d.onOpenMoved(join(dir, baseName(p)) + open.slice(p.length))
            break
          }
          const e = await readApiError(res)
          if (res.status !== 409 || e.code !== "exists") { failure = e; break outer }
          const decision: { a: Answer; all: boolean } = always ? { a: always, all: false } : await ask(baseName(p))
          if (decision.all) always = decision.a
          if (decision.a === "cancel") break outer
          if (decision.a === "skip") break
          overwrite = true
        }
      }
    } catch { failure = d.network } finally {
      d.clearSelection()
      try { await Promise.all([...new Set([parentOf(paths[0]), dir])].map((x) => d.load(x))) } finally { d.setBusy(false) }
    }
    if (failure) d.setErr({ ...failure, message: `ย้าย ${failedName} ไม่สำเร็จ — ย้ายแล้ว ${done} จาก ${paths.length} รายการ — ${failure.message}` })
  }

  return {
    conflict, move,
    replace: (all: boolean) => answer("replace", all),
    skip: (all: boolean) => answer("skip", all),
    cancel: () => answer("cancel"),
  }
}
