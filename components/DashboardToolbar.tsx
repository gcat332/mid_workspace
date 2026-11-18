"use client"

import { formatBytes, quotaView, type HostView, type MidView } from "@/lib/ui/status-view"
import { ghostBtnCls } from "@/lib/ui/classes"

const GIB = 1024 ** 3

type Props = {
  host: HostView | null
  mids: MidView[]
  onImport: () => void
}

// Dashboard toolbar under the app chrome: quota / RAM chips on the left, Import and create on the right.
export function DashboardToolbar({ host, mids, onImport }: Props) {
  const q = host ? quotaView(host.quotaUsed, host.maxRunning) : null
  const midRam = mids.reduce((s, m) => s + (m.status.memoryBytes ?? 0), 0)
  const lowRam = host !== null && host.availableBytes < GIB

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      {q && host && (
        <>
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${q.full ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
            {q.text}
          </span>
          <span className="min-w-0 text-sm text-gray-700">RAM: MID ใช้ {formatBytes(midRam)} / ทั้งเครื่อง {formatBytes(host.totalBytes)} (ว่าง {formatBytes(host.availableBytes)})</span>
          {lowRam && <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">RAM ว่างเหลือน้อย</span>}
        </>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={onImport} className={ghostBtnCls}>
          Import MID ที่มีอยู่
        </button>
        <span className="flex items-center gap-1.5">
          <button type="button" disabled aria-describedby="create-mid-hint" className="btn-primary px-4 py-2 text-sm font-medium">
            + สร้าง MID ใหม่
          </button>
          <span id="create-mid-hint" className="text-xs text-gray-500">(ยังไม่เปิดให้ใช้ในเวอร์ชันนี้)</span>
        </span>
      </div>
    </div>
  )
}
