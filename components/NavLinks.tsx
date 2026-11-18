"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

// Tab nav under the header: active tab gets a sky-blue underline (AgentHub's NavLinks), others underline on hover.
export function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname()
  const links = [
    { href: "/", label: "Dashboard", active: pathname === "/" },
    ...(isAdmin ? [{ href: "/admin/users", label: "Admin", active: pathname.startsWith("/admin") }] : []),
  ]
  return (
    <div className="flex items-center gap-7 h-full">
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.active ? "page" : undefined}
          className={`flex items-center h-full text-[15px] border-b-2 -mb-px transition-colors ${l.active
            ? "font-medium text-brand-navy dark:text-blue-300 border-brand-sky"
            : "font-normal text-ink-soft dark:text-neutral-400 border-transparent hover:text-brand-navy dark:hover:text-neutral-100 hover:border-brand-sky-soft dark:hover:border-neutral-600"}`}>
          {l.label}
        </Link>
      ))}
    </div>
  )
}
