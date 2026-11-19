"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { apiFetch } from "@/lib/ui/api"
import { applyTheme, readTheme, saveTheme, THEME_KEY, type Theme } from "@/lib/ui/theme"

function initials(email: string): string {
  const local = email.split("@")[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  const pick = (parts.length >= 2 ? [parts[0], parts[1]] : [local]).map((s) => s[0] ?? "")
  return pick.join("").slice(0, 2).toUpperCase() || "?"
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
]

function themeGlyph(v: Theme) {
  const p = { className: "w-[18px] h-[18px]", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true }
  if (v === "light") return <svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
  if (v === "dark") return <svg {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></svg>
  return <svg {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
}

// Profile pill + dropdown (AgentHub's ProfileMenu): avatar, email, theme (light/dark/system), logout.
// Owns the theme switching. Logout keeps MidHub's behaviour: a failure shows an inline alert, no redirect.
export function ProfileMenu({ email, role }: { email: string; role: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>("system")
  const [logoutErr, setLogoutErr] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const isAdmin = role === "admin"

  useEffect(() => {
    const saved = readTheme()
    // localStorage is only readable after hydration (SSR renders "system"), so this one-time sync cannot be an initializer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(saved)
    applyTheme(saved)
  }, [])
  useEffect(() => {
    // Another tab changed the preference: follow it.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return
      const t = readTheme(); setTheme(t); applyTheme(t)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])
  useEffect(() => {
    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => applyTheme("system")
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [theme])
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey) }
  }, [open])

  const chooseTheme = (t: Theme) => { setTheme(t); saveTheme(t); applyTheme(t) }

  async function logout() {
    setLogoutErr(false)
    try {
      const res = await apiFetch("/auth/logout", { method: "POST" })
      if (!res.ok) { setLogoutErr(true); return }
    } catch {
      setLogoutErr(true); return
    }
    // Only MidHub's cookie is cleared; the access page says so and links back to AgentHub.
    router.replace("/login?reason=logged_out"); router.refresh()
  }

  const name = email.split("@")[0] ?? email
  const avatar = "h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-brand-navy to-brand-sky text-white text-[13px] font-semibold flex items-center justify-center"
  const ico = "w-[18px] h-[18px] shrink-0"

  return (
    <div ref={ref} className="relative">
      <button ref={triggerRef} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="เมนูผู้ใช้"
        className={`flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3 transition-colors ${open ? "bg-gray-100 dark:bg-neutral-700" : "hover:bg-gray-100 dark:hover:bg-neutral-700"}`}>
        <span className={avatar} aria-hidden>{initials(email)}</span>
        <span className="hidden sm:flex flex-col items-start leading-tight">
          <span className="text-sm font-medium text-gray-900 dark:text-neutral-100">{name}</span>
          <span className="text-xs text-gray-400 dark:text-neutral-500">{isAdmin ? "Administrator" : "User"}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div ref={menuRef} role="menu" className="absolute right-0 top-[calc(100%+10px)] w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-xl p-2 z-40">
          <div className="flex items-center gap-3 px-2 py-2">
            <span className={avatar.replace("h-9 w-9", "h-11 w-11")} aria-hidden>{initials(email)}</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-neutral-100 truncate">{name}</div>
              <div className="text-xs text-gray-400 dark:text-neutral-500 truncate">{email}</div>
            </div>
          </div>
          <div className="h-px bg-gray-100 dark:bg-neutral-700 my-1.5" />
          <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">Theme</div>
          <div role="group" aria-label="Theme" className="flex gap-1 px-2 pb-1">
            {THEMES.map((t) => (
              <button key={t.value} type="button" role="menuitemradio" aria-checked={theme === t.value} onClick={() => chooseTheme(t.value)}
                className={`flex-1 flex flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors ${theme === t.value ? "bg-blue-50 text-brand-navy dark:bg-blue-950/50 dark:text-blue-300" : "text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-neutral-700"}`}>
                {themeGlyph(t.value)}{t.label}
              </button>
            ))}
          </div>
          <div className="h-px bg-gray-100 dark:bg-neutral-700 my-1.5" />
          <button type="button" role="menuitem" onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-logout-red hover:bg-logout-red-soft dark:hover:bg-red-950/30 transition-colors">
            <svg className={ico} aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
            ออกจากระบบ
          </button>
          {logoutErr && <p role="alert" className="px-3 pt-1 pb-1 text-xs text-red-600">ออกจากระบบไม่สำเร็จ ลองกดอีกครั้ง</p>}
        </div>
      )}
    </div>
  )
}
