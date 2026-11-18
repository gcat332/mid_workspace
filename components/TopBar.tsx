"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatBytes, quotaView, type HostView, type MidView } from "@/lib/ui/status-view"

const GIB = 1024 ** 3
const btn = "rounded-lg px-3 py-1.5 text-sm"

type Props = {
  email: string
  isAdmin: boolean
  host: HostView | null
  mids: MidView[]
  onImport: () => void
}

export function TopBar({ email, isAdmin, host, mids, onImport }: Props) {
  const router = useRouter()
  const q = host ? quotaView(host.quotaUsed, host.maxRunning) : null
  const midRam = mids.reduce((s, m) => s + (m.status.memoryBytes ?? 0), 0)
  const lowRam = host !== null && host.availableBytes < GIB

  async function logout() {
    try { await fetch("/midhub/api/auth/logout", { method: "POST" }) } finally { router.replace("/login"); router.refresh() }
  }

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-white px-4 py-3">
      <h1 className="text-lg font-bold text-gray-900">MidHub</h1>
      {q && host && (
        <>
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${q.full ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
            {q.text}
          </span>
          <span className="text-sm text-gray-700">RAM: MID ใช้ {formatBytes(midRam)} / ทั้งเครื่อง {formatBytes(host.totalBytes)} (ว่าง {formatBytes(host.availableBytes)})</span>
          {lowRam && <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">RAM ว่างเหลือน้อย</span>}
        </>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={onImport} className={`${btn} border border-gray-300 text-gray-700 hover:bg-gray-50`}>
          Import MID ที่มีอยู่
        </button>
        <button type="button" disabled title="เปิดใช้ใน Phase 2" className={`${btn} bg-blue-600 text-white disabled:opacity-50`}>
          + สร้าง MID ใหม่
        </button>
        {isAdmin && <Link href="/admin/users" className={`${btn} text-blue-600 hover:underline`}>Admin</Link>}
        <span className="text-sm text-gray-500">{email}</span>
        <button type="button" onClick={logout} className={`${btn} text-gray-700 hover:bg-gray-100`}>ออกจากระบบ</button>
      </div>
    </header>
  )
}
