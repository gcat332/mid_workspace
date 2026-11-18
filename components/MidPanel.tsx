"use client"

import { useRef, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { ConfigTab } from "./ConfigTab"
import { FilesTab } from "./FilesTab"
import { LogTab } from "./LogTab"
import { OverviewTab } from "./OverviewTab"
import { apiFetch } from "@/lib/ui/api"
import { statusView, type HostView, type MidView } from "@/lib/ui/status-view"

const TABS = [
  { id: "overview", label: "ภาพรวม" },
  { id: "config", label: "ตั้งค่า" },
  { id: "files", label: "ไฟล์" },
  { id: "logs", label: "Log" },
] as const
type TabId = (typeof TABS)[number]["id"]

type Action = "start" | "stop" | "restart"
type Pending = { action: Action; lowMemory?: string }

const ACTION_TH: Record<Action, string> = { start: "Start", stop: "Stop", restart: "Restart" }
const FULL_REASON = "รันครบ 4 ตัวแล้ว ให้หยุดตัวอื่นก่อน"
const HOST_UNKNOWN = "อ่านสถานะเครื่องไม่ได้ จึงยังกด Start ไม่ได้ รอสักครู่หรือรีเฟรชหน้า"
const PHASE_HINT = "เปิดใช้ใน Phase 2/3"
const hdrBtn = "rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"

type Props = { mid: MidView; host: HostView | null; onChanged: () => void }

export function MidPanel({ mid, host, onChanged }: Props) {
  const [tab, setTab] = useState<TabId>("overview")
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)

  const sv = statusView(mid)
  const st = mid.status.state
  const isUp = st === "running" || st === "starting"
  const hostKnown = host !== null
  const quotaFull = host !== null && host.quotaUsed >= host.maxRunning
  const startBlocked = !isUp && (quotaFull || !hostKnown)
  const startReason = !hostKnown ? HOST_UNKNOWN : FULL_REASON
  const inFlight = useRef(false)
  const transitional = mid.state === "installing" || mid.state === "upgrading" || mid.state === "uninstalling"
  const holdsStale = host !== null && host.quotaUsed > host.running

  // An open Stop/Restart confirm is moot once polling shows the MID is no longer up.
  if (pending && !pending.lowMemory && pending.action !== "start" && !isUp && !busy) setPending(null)

  async function send(action: Action, confirmLowMemory: boolean) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setErr(null)
    try {
      const res = await apiFetch(`/mids/${encodeURIComponent(mid.name)}/actions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmLowMemory ? { action, confirmLowMemory: true } : { action }),
      })
      if (res.ok) { setPending(null); onChanged(); return }
      const e = await readApiError(res)
      if (e.code === "low_memory" && !confirmLowMemory) { setPending({ action, lowMemory: e.message }); return }
      setPending(null); setErr(e)
    } catch {
      setPending(null); setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function request(action: Action) {
    setErr(null)
    if (action === "start") void send("start", false)
    else setPending({ action })
  }

  return (
    <section aria-label={`MID ${mid.name}`} className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-xl font-semibold text-gray-900">{mid.name}</h2>
        <span className="text-sm text-gray-600">{sv.icon} {sv.label}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={() => request("restart")} disabled={busy || transitional || !isUp}
            title={!isUp ? "MID ยังไม่ได้รัน ใช้ Start แทน" : undefined}
            className={`${hdrBtn} border-gray-300 text-gray-800 hover:bg-gray-50`}>Restart</button>
          {isUp ? (
            <button type="button" onClick={() => request("stop")} disabled={busy || transitional}
              className={`${hdrBtn} border-red-300 text-red-700 hover:bg-red-50`}>Stop</button>
          ) : (
            <button type="button" onClick={() => request("start")} disabled={busy || transitional || startBlocked}
              title={startBlocked ? startReason : undefined}
              className={`${hdrBtn} border-green-600 bg-green-600 text-white hover:bg-green-700`}>Start</button>
          )}
          <button type="button" disabled title={PHASE_HINT} className={`${hdrBtn} border-gray-300 text-gray-800`}>Upgrade</button>
          <button type="button" disabled title={PHASE_HINT} className={`${hdrBtn} border-gray-300 text-gray-800`}>ลบ</button>
        </div>
      </div>
      {startBlocked && <p className="mt-2 text-sm text-amber-700">{startReason}</p>}
      {holdsStale && (
        <p className="mt-1 text-xs text-gray-500">
          MID ที่ล่มหรือหยุดเองยังนับเป็น 1 ช่องจนกว่าจะกด Stop
        </p>
      )}
      {err && <div className="mt-3"><ErrorNotice error={err} /></div>}

      <div role="tablist" aria-label="รายละเอียด MID" className="mt-4 flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="tabpanel"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === t.id ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tab}`} className="pt-4">
        {tab === "overview" && <OverviewTab mid={mid} />}
        {tab === "config" && <ConfigTab midName={mid.name} canRestart={isUp && !transitional} onRestart={() => void send("restart", false)} />}
        {tab === "files" && <FilesTab midName={mid.name} />}
        {tab === "logs" && <LogTab midName={mid.name} />}
      </div>

      {pending && (
        // One dialog instance for both steps so the opener (and focus restore) survives the low-memory handoff.
        <ConfirmDialog
          title={pending.lowMemory ? "RAM เหลือน้อย ทำต่อหรือไม่?" : `${ACTION_TH[pending.action]} ${mid.name}?`}
          danger busy={busy}
          confirmLabel={pending.lowMemory ? "ยืนยัน ทำต่อ" : ACTION_TH[pending.action]}
          onCancel={() => setPending(null)} onConfirm={() => void send(pending.action, !!pending.lowMemory)}>
          {pending.lowMemory ??
            (pending.action === "stop"
              ? "MID จะหยุดทำงานและ ServiceNow จะเห็นว่า MID นี้ down"
              : "MID จะหยุดแล้วเริ่มใหม่ งานที่กำลังทำอยู่จะถูกขัดจังหวะ")}
        </ConfirmDialog>
      )}
    </section>
  )
}
