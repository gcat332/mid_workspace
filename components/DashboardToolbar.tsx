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

const segCls = "flex min-w-0 grow flex-col justify-center bg-white px-4 py-2 dark:bg-neutral-800"
const labelCls = "text-xs font-medium text-gray-600"
const valueCls = "text-sm font-semibold text-gray-900"

// Dashboard toolbar under the app chrome: one stats card (hairline-divided segments) on the left, Import and create on the right.
export function DashboardToolbar({ host, mids, onImport, onCreate }: Props) {
  const q = host ? quotaView(host.quotaUsed, host.maxRunning) : null
  const midRam = mids.reduce((s, m) => s + (m.status.memoryBytes ?? 0), 0)
  const lowRam = host !== null && host.availableBytes < GIB
  const usedPct = host && host.totalBytes > 0 ? Math.min(100, Math.round((midRam / host.totalBytes) * 100)) : 0
  const diskLow = host?.disk?.freeBytes != null && host.disk.freeBytes < MIN_FREE_BYTES

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
      {q && host && (
        <div aria-label="Host Stats" role="group"
          className="flex min-w-0 flex-1 basis-96 flex-wrap gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 shadow-[0_1px_2px_rgba(23,35,50,0.06)] dark:border-neutral-700 dark:bg-neutral-700">
          <div className={segCls}>
            <span className={labelCls}>Running</span>
            <span className={`${valueCls} ${q.full ? "text-amber-800 dark:text-amber-300" : ""}`}>
              {host.quotaUsed} <span className="font-normal text-gray-600">/ {host.maxRunning}</span>
            </span>
          </div>
          <div className={`${segCls} basis-64`}>
            <span className={labelCls}>Memory</span>
            <span className={valueCls}>
              {formatBytes(midRam)} MID{" "}
              <span className="text-xs font-normal text-gray-600">· {formatBytes(host.availableBytes)} free of {formatBytes(host.totalBytes)}</span>
            </span>
            <span role="meter" aria-label="Memory used by MID" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct}
              className="mt-1 block h-1 overflow-hidden rounded-full bg-gray-200">
              <span className="block h-full rounded-full bg-blue-600" style={{ width: `${usedPct}%` }} />
            </span>
          </div>
          {host.disk && host.disk.freeBytes !== null && (
            <div className={segCls}
              title={host.disk.usage ? undefined : "ไม่สามารถอ่านการใช้พื้นที่แยกตามโฟลเดอร์ได้"}>
              <span className={labelCls}>Disk Free</span>
              <span className={`${valueCls} ${diskLow ? "text-amber-800 dark:text-amber-300" : ""}`}>{(host.disk.freeBytes / GIB).toFixed(1)} GB</span>
            </div>
          )}
          {host.disk?.usage && (
            <div className={`${segCls} basis-64`}>
              <span className={labelCls}>Storage</span>
              <span className="text-xs text-gray-600">
                MID {formatBytes(host.disk.usage.mids)} · Packages {formatBytes(host.disk.usage.packages)} · Archive {formatBytes(host.disk.usage.archive)}
              </span>
            </div>
          )}
          {lowRam && (
            <div className={`${segCls} grow-0 justify-center`}>
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">Low RAM</span>
            </div>
          )}
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={onImport} className={ghostBtnCls}>
          Import MID Server
        </button>
        <button type="button" onClick={onCreate} className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium">
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          New MID Server
        </button>
      </div>
    </div>
  )
}
