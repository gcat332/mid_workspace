"use client"

import { useSyncExternalStore } from "react"

function subscribeDark(cb: () => void) {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => mo.disconnect()
}

/** True while <html> has the .dark class (follows live changes; false during SSR). Used for Monaco's theme. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, () => document.documentElement.classList.contains("dark"), () => false)
}
