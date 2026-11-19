"use client"

import { formatBytes, quotaView, type HostView, type MidView } from "@/lib/ui/status-view"
import { MIN_FREE_BYTES } from "@/lib/mids/layout"
import { ghostBtnCls } from "@/lib/ui/classes"

const GIB = 1024 ** 3

type Props = {
  host: HostView | null
  mids: MidView[]
  onImport: () => void
  onCreate: () => void
}

// Dashboard toolbar under the app chrome: quota / RAM chips on the left, Import and create on the right.
export function DashboardToolbar({ host, mids, onImport, onCreate }: Props) {
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
          <span className="min-w-0 text-sm text-gray-700">RAM: MID {formatBytes(midRam)} / Total {formatBytes(host.totalBytes)} (Free {formatBytes(host.availableBytes)})</span>
          {host.disk && host.disk.freeBytes !== null && (
            <span
              title={host.disk.usage ? `MID ${formatBytes(host.disk.usage.mids)} · Packages ${formatBytes(host.disk.usage.packages)} · archive ${formatBytes(host.disk.usage.archive)}` : "ไม่สามารถอ่านการใช้พื้นที่แยกตามโฟลเดอร์ได้"}
              className={`rounded-full px-3 py-1 text-sm font-medium ${host.disk.freeBytes < MIN_FREE_BYTES ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}
            >
              Disk Free {(host.disk.freeBytes / GIB).toFixed(1)} GB
            </span>
          )}
          {host.disk?.usage && (
            <span className="min-w-0 text-xs text-gray-600">
              MID {formatBytes(host.disk.usage.mids)} · Packages {formatBytes(host.disk.usage.packages)} · archive {formatBytes(host.disk.usage.archive)}
            </span>
          )}
          {lowRam && <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">Low RAM</span>}
        </>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={onImport} className={ghostBtnCls}>
          Import MID Server
        </button>
        <button type="button" onClick={onCreate} className="btn-primary px-4 py-2 text-sm font-medium">
          + New MID Server
        </button>
      </div>
    </div>
  )
}
