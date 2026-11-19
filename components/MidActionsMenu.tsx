"use client"

import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react"

export type MenuAction = {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Why the item is disabled (or what it does): shown as the title and read by screen readers. */
  reason?: string | null
  danger?: boolean
}

const item = "block w-full px-3 py-1.5 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-neutral-700 dark:focus:bg-neutral-700"
const normal = `${item} text-gray-700 dark:text-neutral-200`
const danger = `${item} text-red-600 hover:bg-red-50 focus:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 dark:focus:bg-red-950/40`

/** The panel header's "⋯" button and its menu. Closes on Esc or an outside press and returns focus to the button. */
export function MidActionsMenu({ items }: { items: MenuAction[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const uid = useId()

  useEffect(() => {
    if (!open) return
    wrap.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus()
    const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener("mousedown", onDown, true)
    document.addEventListener("touchstart", onDown, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown, true)
      document.removeEventListener("touchstart", onDown, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  function onArrow(e: KeyboardEvent) {
    if (e.key === "Tab") { setOpen(false); return }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const els = Array.from(wrap.current!.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])"))
    if (!els.length) return
    const at = els.indexOf(document.activeElement as HTMLElement)
    els[(at + (e.key === "ArrowDown" ? 1 : els.length - 1)) % els.length].focus()
  }

  return (
    <div ref={wrap} className="relative">
      <button ref={trigger} type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 dark:text-neutral-200 dark:hover:bg-neutral-700">
        <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="currentColor"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label="More actions" onKeyDown={onArrow}
          className="absolute right-0 z-30 mt-1 min-w-48 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-xl dark:border-neutral-700 dark:bg-neutral-800">
          {items.map((it, i) => {
            const rid = `${uid}-r${i}`
            return (
              <Fragment key={it.label}>
              <button type="button" role="menuitem" disabled={it.disabled} title={it.reason ?? undefined}
                aria-describedby={it.reason ? rid : undefined} className={it.danger ? danger : normal}
                onClick={() => { setOpen(false); trigger.current?.focus(); it.onSelect() }}>
                {it.label}
              </button>
              {it.reason && <span id={rid} className="sr-only">{it.reason}</span>}
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
