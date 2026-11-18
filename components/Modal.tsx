"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), a[href]"

type Props = { labelledBy: string; onClose: () => void; busy?: boolean; children: ReactNode }

/**
 * Shared accessible modal shell: portal to body, background made inert, Esc closes (unless busy), Tab trapped,
 * focus moves in on open, stays inside when the focused control becomes disabled, and returns to the opener on close.
 */
export function Modal({ labelledBy, onClose, busy, children }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  const closeRef = useRef(onClose)
  useEffect(() => { busyRef.current = busy; closeRef.current = onClose })

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const overlay = overlayRef.current!
    const inerted = Array.from(document.body.children).filter((el) => el !== overlay && !el.hasAttribute("inert"))
    inerted.forEach((el) => el.setAttribute("inert", ""))

    const dlg = dialogRef.current!
    const initial = dlg.querySelector<HTMLElement>("[data-autofocus]") ?? dlg.querySelector<HTMLElement>(FOCUSABLE) ?? dlg
    initial.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) { closeRef.current(); return }
      if (e.key !== "Tab") return
      const els = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (els.length === 0) { e.preventDefault(); dlg.focus(); return }
      const first = els[0], last = els[els.length - 1]
      const active = document.activeElement
      if (!dlg.contains(active) || active === dlg) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      inerted.forEach((el) => el.removeAttribute("inert"))
      opener?.focus?.()
    }
  }, [])

  // A focused button that turns disabled (busy) drops focus to <body>; pull it back into the dialog.
  useEffect(() => {
    const dlg = dialogRef.current
    if (dlg && !dlg.contains(document.activeElement)) dlg.focus()
  }, [busy])

  return createPortal(
    <div ref={overlayRef} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl focus:outline-none">
        {children}
      </div>
    </div>,
    document.body,
  )
}
