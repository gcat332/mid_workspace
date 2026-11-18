"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const links = [
  { href: "/admin/users", label: "ผู้ใช้" },
  { href: "/admin/idp", label: "IdP (SSO)" },
  { href: "/admin/ip-allowlist", label: "IP Allowlist" },
  { href: "/admin/audit", label: "Audit" },
]

export function AdminNav() {
  const pathname = usePathname()
  return (
    <div className="mb-6">
      <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 hover:underline">← กลับหน้าหลัก</Link>
      <nav aria-label="Admin" className="mt-3 flex gap-1 overflow-x-auto border-b border-gray-200 text-sm">
        {links.map((l) => {
          const active = pathname === l.href
          return (
            <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
              className={`-mb-px shrink-0 border-b-2 px-4 py-2 ${active ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"}`}>
              {l.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
