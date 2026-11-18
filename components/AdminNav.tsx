import Link from "next/link"

const links = [
  { href: "/admin/users", label: "ผู้ใช้" },
  { href: "/admin/idp", label: "IdP (SSO)" },
  { href: "/admin/ip-allowlist", label: "IP Allowlist" },
  { href: "/admin/audit", label: "Audit" },
]

export function AdminNav() {
  return (
    <nav aria-label="Admin" className="mb-6 flex flex-wrap gap-4 border-b border-gray-200 pb-3 text-sm">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="text-blue-600 hover:underline">{l.label}</Link>
      ))}
    </nav>
  )
}
