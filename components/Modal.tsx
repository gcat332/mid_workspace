"use client"

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]"

// Open modals, outermost first: only the top-most one reacts to Esc/Tab (a ConfirmDialog nested in the wizard).
// Nesting is tracked by context depth (React runs child effects before parent effects, so mount order is not reliable).
const open: number[] = []
const Depth = createContext(0)

type Props = { labelledBy: string; onClose: () => void; busy?: boolean; /** full-height wide dialog (full-screen sheet on phones) */ wide?: boolean; children: ReactNode }

/**
 * Shared accessible modal shell: portal to body, background made inert, Esc closes (unless busy), Tab trapped,
 * focus moves in on open, stays inside when the focused control becomes disabled, and returns to the opener on close.
 */
export function Modal({ labelledBy, onClose, busy, wide, children }: Props) {
  const level = useContext(Depth) + 1
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  const closeRef = useRef(onClose)
  useEffect(() => { busyRef.current = busy; closeRef.current = onClose })

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const overlay = overlayRef.current!
    const inerted = Array.from(document.body.children).filter((el) => el !== overlay && !el.hasAttribute("inert") && Number(el.getAttribute("data-modal-level") ?? 0) < level)
    inerted.forEach((el) => el.setAttribute("inert", ""))

    const dlg = dialogRef.current!
    const initial = dlg.querySelector<HTMLElement>("[data-autofocus]") ?? dlg.querySelector<HTMLElement>(FOCUSABLE) ?? dlg
    open.push(level)
    // A nested child modal's effect runs first and already took focus; do not steal it back.
    if (level >= Math.max(...open)) initial.focus()

    const onKey = (e: KeyboardEvent) => {
      if (level < Math.max(...open)) return
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
      const at = open.indexOf(level)
      if (at >= 0) open.splice(at, 1)
      inerted.forEach((el) => el.removeAttribute("inert"))
      if (opener?.isConnected) opener.focus?.()
    }
  }, [level])

  // A focused button that turns disabled (busy) drops focus to <body>; pull it back into the dialog.
  useEffect(() => {
    const dlg = dialogRef.current
    if (dlg && level >= Math.max(...open) && !dlg.contains(document.activeElement)) dlg.focus()
  }, [busy, level])

  // z-[65]: above the full-screen file editor (z-[60]) so its unsaved-changes confirm shows on top (as AgentHub).
  return createPortal(
    <div ref={overlayRef} data-modal-level={level} className={`fixed inset-0 z-[65] flex items-center justify-center bg-black/40 ${wide ? "p-0 sm:p-4" : "p-4"}`}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
        className={wide
          ? "flex h-full w-full flex-col bg-white dark:bg-neutral-800 shadow-xl focus:outline-none sm:h-[min(92vh,52rem)] sm:max-w-3xl sm:rounded-xl"
          : "w-full max-w-md rounded-xl bg-white dark:bg-neutral-800 p-5 shadow-xl focus:outline-none"}>
        <Depth.Provider value={level}>{children}</Depth.Provider>
      </div>
    </div>,
    document.body,
  )
}
