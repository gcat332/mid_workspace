"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const links = [
  { href: "/admin/users", label: "ผู้ใช้" },
  { href: "/admin/idp", label: "IdP (SSO)" },
  { href: "/admin/ip-allowlist", label: "IP Allowlist" },
  { href: "/admin/audit", label: "Audit" },
]

// Admin sub-tabs under the app chrome (the "Admin" tab there leads here). Same underline language as the chrome nav.
export function AdminNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Admin" className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-200 text-sm">
      {links.map((l) => {
        const active = pathname === l.href
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-4 py-2 transition-colors ${active ? "border-brand-sky font-medium text-brand-navy dark:text-blue-300" : "border-transparent text-gray-600 hover:text-gray-900 hover:border-brand-sky-soft"}`}>
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
