"use client"

import { useRef, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { ConfigTab } from "./ConfigTab"
import { FilesTab } from "./FilesTab"
import { LogTab } from "./LogTab"
import { JobProgress } from "./JobProgress"
import { OverviewTab } from "./OverviewTab"
import { apiFetch } from "@/lib/ui/api"
import { failedJobShown, jobIsActive, statusView, type HostView, type MidView } from "@/lib/ui/status-view"
import { tabKeyTarget } from "@/lib/ui/tabs"
import { quotaFullMessage } from "@/lib/mids/messages"

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "config", label: "Configuration" },
  { id: "files", label: "Files" },
  { id: "logs", label: "Logs" },
] as const
type TabId = (typeof TABS)[number]["id"]

type Action = "start" | "stop" | "restart"
type Pending = { action: Action; lowMemory?: string }

const ACTION_TH: Record<Action, string> = { start: "Start", stop: "Stop", restart: "Restart" }
const HOST_UNKNOWN = "อ่านสถานะเครื่องไม่ได้ จึงยังกด Start ไม่ได้ รอสักครู่หรือรีเฟรชหน้า"
const NOT_YET = "Upgrade ยังไม่เปิดให้ใช้ในเวอร์ชันนี้"
const JOB_BUSY = "มีงานกำลังทำอยู่"
const JOB_FAILED = "งานล้มเหลว — ลองใหม่หรือยกเลิกด้านล่าง"
const NEED_ADMIN = "ต้องเป็น Admin"
const UNINSTALL_STATE = "ลบได้เฉพาะ MID ที่ติดตั้งเสร็จหรือมีปัญหา"
const RESTART_WHEN_UP = "Restart ใช้ได้เมื่อ MID กำลังรัน (ตอนนี้ใช้ Start แทน)"
const hdrBtn = "rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"

type Props = {
  mid: MidView
  host: HostView | null
  isAdmin: boolean
  userId: string
  onChanged: () => void
  /** The dashboard's uninstall dialog currently owns this MID's job (it shows the progress itself). */
  jobOwnedElsewhere?: boolean
  /** A job was just accepted but the next poll has not reported it yet. */
  optimisticBusy?: boolean
  /** Opens the uninstall dialog (owned by the dashboard so it outlives this panel once the MID leaves the list). */
  onUninstall: (mid: MidView) => void
}

export function MidPanel({ mid, host, isAdmin, userId, onChanged, onUninstall, jobOwnedElsewhere = false, optimisticBusy = false }: Props) {
  const [tab, setTab] = useState<TabId>("overview")
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)
  const [fixing, setFixing] = useState(false)
  const [fixed, setFixed] = useState(false)

  const sv = statusView(mid)
  const st = mid.status.state
  const isUp = st === "running" || st === "starting"
  const hostKnown = host !== null
  const quotaFull = host !== null && host.quotaUsed >= host.maxRunning
  const startBlocked = !isUp && (quotaFull || !hostKnown)
  const startReason = !hostKnown ? HOST_UNKNOWN : quotaFullMessage(host.maxRunning)
  const inFlight = useRef(false)
  const transitional = mid.state === "installing" || mid.state === "upgrading" || mid.state === "uninstalling"
  const jobActive = jobIsActive(mid)
  // One reason for everything that writes: Start/Stop/Restart/fix, config save, file writes.
  const busyReason = jobActive || optimisticBusy ? JOB_BUSY
    : transitional ? (failedJobShown(mid) ? JOB_FAILED : JOB_BUSY)
    : null
  const uninstallReason = !isAdmin ? NEED_ADMIN
    : mid.state !== "installed" && mid.state !== "error" ? UNINSTALL_STATE
    : busyReason
  // A job started here stays on screen after it ends (so its result and links are not yanked away by the next poll).
  const [watched, setWatched] = useState<string | null>(null)
  if (mid.job && jobActive && watched !== mid.job.id) setWatched(mid.job.id)
  const showJob = !jobOwnedElsewhere && !!mid.job && (jobActive || failedJobShown(mid) || watched === mid.job.id)
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

  /** "Repair Permissions": the root helper makes the whole MID tree midsvc:midhub and group-writable (audited). */
  async function fixOwnership() {
    setErr(null); setFixed(false); setFixing(true)
    try {
      const res = await apiFetch(`/mids/${encodeURIComponent(mid.name)}/actions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "fixOwnership" }),
      })
      if (res.ok) setFixed(true)
      else setErr(await readApiError(res))
    } catch {
      setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally {
      setFixing(false)
    }
  }

  function request(action: Action) {
    setErr(null)
    if (action === "start") void send("start", false)
    else setPending({ action })
  }

  function selectTab(id: TabId) {
    setTab(id)
    setErr(null); setFixed(false) // an action error belongs to the moment it happened, not to every tab
  }
  function onTabKey(e: React.KeyboardEvent) {
    const i = tabKeyTarget(e.key, TABS.findIndex((t) => t.id === tab), TABS.length)
    if (i === null) return
    e.preventDefault()
    selectTab(TABS[i].id)
    document.getElementById(`tab-${TABS[i].id}`)?.focus()
  }

  // Visible reasons for disabled header buttons (a title tooltip alone is invisible on touch and to many users).
  const reasons = [
    busyReason,
    !busyReason && !isUp ? RESTART_WHEN_UP : null,
    NOT_YET,
    uninstallReason && uninstallReason !== busyReason ? `Uninstall: ${uninstallReason}` : null,
  ].filter(Boolean) as string[]

  return (
    <section aria-label={`MID ${mid.name}`} className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 min-w-0 break-all text-xl font-semibold text-gray-900">{mid.name}</h2>
        <span className="text-sm text-gray-600">{sv.icon} {sv.label}</span>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <button type="button" onClick={() => request("restart")} disabled={busy || !!busyReason || !isUp}
            aria-describedby="mid-btn-reasons"
            className={`${hdrBtn} border-gray-300 text-gray-800 hover:bg-gray-50`}>Restart</button>
          {isUp ? (
            <button type="button" onClick={() => request("stop")} disabled={busy || !!busyReason}
              className={`${hdrBtn} border-red-300 text-red-700 hover:bg-red-50`}>Stop</button>
          ) : (
            <button type="button" onClick={() => request("start")} disabled={busy || !!busyReason || startBlocked}
              aria-describedby={startBlocked ? "mid-start-reason" : undefined}
              className={`${hdrBtn} border-success-solid bg-success-solid text-white hover:bg-success-solid-press`}>Start</button>
          )}
          <button type="button" onClick={() => void fixOwnership()} disabled={fixing || !!busyReason}
            title="ให้ไฟล์ทั้งหมดของ MID เป็นของ midsvc:midhub และกลุ่มแก้ไขได้ (ใช้เมื่อแก้ไฟล์ไม่ได้เพราะสิทธิ์)"
            className={`${hdrBtn} border-gray-300 text-gray-800 hover:bg-gray-50`}>{fixing ? "Repairing…" : "Repair Permissions"}</button>
          <button type="button" disabled aria-describedby="mid-btn-reasons" className={`${hdrBtn} border-gray-300 text-gray-800`}>Upgrade</button>
          <button type="button" onClick={() => onUninstall(mid)} disabled={uninstallReason !== null} aria-describedby="mid-btn-reasons"
            className={`${hdrBtn} border-red-300 text-red-700 hover:bg-red-50`}>Uninstall</button>
        </div>
      </div>
      <p id="mid-btn-reasons" className="mt-1 text-xs text-gray-500">{reasons.join(" · ")}</p>
      {startBlocked && <p id="mid-start-reason" className="mt-2 text-sm text-amber-700">{startReason}</p>}
      {holdsStale && (
        <p className="mt-1 text-xs text-gray-500">
          MID ที่ล่มหรือหยุดเองยังนับเป็น 1 ช่องจนกว่าจะกด Stop
        </p>
      )}
      {fixed && <p role="status" className="mt-2 text-sm text-emerald-700">ซ่อมสิทธิ์ไฟล์แล้ว ลองทำรายการเดิมอีกครั้ง</p>}
      {err && <div className="mt-3"><ErrorNotice error={err} /></div>}
      {showJob && mid.job && (
        <div className="mt-4 rounded-xl border border-gray-200 p-4">
          <JobProgress key={mid.job.id} viewer={{ isAdmin, userId }} jobId={mid.job.id} onJobChange={() => onChanged()}
            onOpenMid={() => setWatched(null)} onClose={() => setWatched(null)} />
        </div>
      )}

      <div role="tablist" aria-label="MID Details" onKeyDown={onTabKey} className="mt-4 flex gap-1 overflow-x-auto border-b border-gray-200">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="tabpanel"
            tabIndex={tab === t.id ? 0 : -1} onClick={() => selectTab(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-4 py-2 text-sm ${tab === t.id ? "border-brand-sky font-medium text-brand-navy dark:text-blue-300" : "border-transparent text-gray-600 hover:text-gray-900"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tab}`} className="pt-4">
        {tab === "overview" && <OverviewTab mid={mid} jobShown={showJob} busyReason={busyReason} onChanged={onChanged} />}
        {tab === "config" && <ConfigTab midName={mid.name} busyReason={busyReason} canRestart={isUp && !transitional} onRestart={() => void send("restart", false)} />}
        {tab === "files" && <FilesTab midName={mid.name} busyReason={busyReason} onOpenConfig={() => selectTab("config")} />}
        {tab === "logs" && <LogTab midName={mid.name} />}
      </div>

      {pending && (
        // One dialog instance for both steps so the opener (and focus restore) survives the low-memory handoff.
        <ConfirmDialog
          title={pending.lowMemory ? "Low RAM. Continue?" : `${ACTION_TH[pending.action]} ${mid.name}?`}
          danger busy={busy}
          confirmLabel={pending.lowMemory ? "Confirm" : `${ACTION_TH[pending.action]}`}
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
