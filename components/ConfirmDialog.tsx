"use client"

import { useEffect, useRef, type ReactNode } from "react"

type Props = {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [href]"

/** Accessible modal: role=dialog, labelled, Esc cancels, Tab is trapped, focus returns to the opener. */
export function ConfirmDialog({ title, children, confirmLabel, danger, busy, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  const cancelFn = useRef(onCancel)
  useEffect(() => { busyRef.current = busy; cancelFn.current = onCancel })

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) { cancelFn.current(); return }
      if (e.key !== "Tab" || !ref.current) return
      const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (els.length === 0) return
      const first = els[0], last = els[els.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("keydown", onKey); opener?.focus?.() }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 id="confirm-title" className="text-lg font-semibold text-gray-900">{title}</h2>
        <div className="mt-2 text-sm text-gray-700">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            ยกเลิก
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}`}>
            {busy ? "กำลังดำเนินการ..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
