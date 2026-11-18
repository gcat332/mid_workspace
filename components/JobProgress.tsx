"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { API_BASE, apiFetch, safeHttpUrl } from "@/lib/ui/api"
import { ghostBtnCls } from "@/lib/ui/classes"
import { createLatest } from "@/lib/ui/latest"
import { isActiveJobStatus, isRemovalKind, jobStageLabel } from "@/lib/ui/stages"
import { parseProgress, type JournalEntry } from "@/lib/ui/wizard"

type JobView = {
  id: string; kind: string; midName: string; stage: string; status: string; error: string | null
  createdBy?: string
  stages: string[]; params: { snName?: string }
}
type Props = {
  jobId: string
  /** The shown job changed (retry keeps the id; cancel moves to the cleanup job). */
  onJobChange: (id: string) => void
  onOpenMid: (name: string) => void
  onClose: () => void
  /** Called whenever the loaded job's kind/status changes (lets a host show a follow-up such as the instance record link). */
  /** Who is looking: retry/cancel follow the engine's rules (removal = admin only; install/clone = creator or admin). */
  viewer: { isAdmin: boolean; userId: string }
  onStatus?: (job: { kind: string; status: string }) => void
}

const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const MAX_LINES = 500

function lineText(e: JournalEntry): string | null {
  switch (e.type) {
    case "log": return e.msg ?? null
    case "stage": return e.stage ? `▶ ${jobStageLabel(e.stage)}` : null
    case "retry": return "ลองใหม่อีกครั้ง"
    case "cancelled": return "ยกเลิกงานแล้ว"
    case "done": return "เสร็จสิ้น"
    case "error": return `ผิดพลาด: ${e.message ?? ""}${e.detail ? `\n${e.detail}` : ""}`
    default: return null
  }
}

export function JobProgress({ jobId, onJobChange, onOpenMid, onClose, onStatus, viewer }: Props) {
  const [job, setJob] = useState<JobView | null>(null)
  const [lines, setLines] = useState<JournalEntry[]>([])
  const [streamErr, setStreamErr] = useState<ApiError | null>(null)
  const [actionErr, setActionErr] = useState<ApiError | null>(null)
  const [loadErr, setLoadErr] = useState<ApiError | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conn, setConn] = useState(0) // bump to reconnect
  const [targetErr, setTargetErr] = useState(false)
  const [target, setTarget] = useState<{ url: string | null; sn: string } | null>(null)
  const logRef = useRef<HTMLUListElement>(null)

  const reconnect = () => { setLines([]); setStreamErr(null); setConn((n) => n + 1) }
  const latest = useRef(createLatest())
  const inflight = useRef(false)
  const again = useRef(false)
  const terminal = useRef(false)
  const targetAsked = useRef(false)

  // After a successful install: where to validate (instance URL + the MID's name in ServiceNow).
  const loadTarget = useCallback(async (j: JobView) => {
    try {
      const res = await apiFetch("/mids")
      if (!res.ok) throw new Error("mids")
      const list = (await res.json()) as { name: string; instanceUrl: string | null; midName: string | null }[]
      const m = list.find((x) => x.name === j.midName)
      setTarget({ url: safeHttpUrl(m?.instanceUrl ?? null), sn: m?.midName ?? j.params.snName ?? j.midName })
      setTargetErr(false)
    } catch {
      targetAsked.current = false
      setTargetErr(true)
      setTarget({ url: null, sn: j.params.snName ?? j.midName })
    }
  }, [])

  // At most one request in flight plus one trailing; a terminal status is never replaced by a non-terminal one
  // (reconnect()/retry reset that, since a retry legitimately restarts the job).
  const loadJob = useCallback(async () => {
    if (inflight.current) { again.current = true; return }
    inflight.current = true
    try {
      do {
        again.current = false
        const token = latest.current.next()
        try {
          const res = await apiFetch(`/jobs/${encodeURIComponent(jobId)}`)
          if (!latest.current.isCurrent(token)) continue
          if (!res.ok) { setLoadErr(await readApiError(res)); continue }
          const j = (await res.json()) as JobView
          if (!latest.current.isCurrent(token)) continue
          if (terminal.current && isActiveJobStatus(j.status)) continue
          if (!isActiveJobStatus(j.status)) terminal.current = true
          setJob(j); setLoadErr(null)
          if (j.status === "succeeded" && (j.kind === "install" || j.kind === "clone") && !targetAsked.current) {
            targetAsked.current = true
            void loadTarget(j)
          }
        } catch {
          setLoadErr(NET)
        }
      } while (again.current)
    } finally {
      inflight.current = false
    }
  }, [jobId, loadTarget])

  useEffect(() => { void Promise.resolve().then(loadJob) }, [loadJob, conn])

  const statusRef = useRef(onStatus)
  useEffect(() => { statusRef.current = onStatus })
  useEffect(() => { if (job) statusRef.current?.({ kind: job.kind, status: job.status }) }, [job])

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/events`)
    es.onmessage = (ev: MessageEvent) => {
      let entry: JournalEntry
      try { entry = JSON.parse(ev.data as string) as JournalEntry } catch { return }
      if (!entry || typeof entry !== "object") return
      setLines((prev) => [...prev, entry].slice(-MAX_LINES))
      if (entry.type === "stage" || entry.type === "error") void loadJob()
    }
    es.addEventListener("done", () => {
      es.close()
      void loadJob()
    })
    es.addEventListener("error", (ev: Event) => {
      es.close()
      let message = "การเชื่อมต่อเพื่อดูความคืบหน้าหลุด งานยังทำงานต่อบนเซิร์ฟเวอร์ กดเชื่อมต่อใหม่เพื่อดูต่อ"
      try {
        const d = JSON.parse((ev as MessageEvent).data as string) as { message?: string }
        if (typeof d.message === "string") message = d.message
      } catch { /* plain connection error: keep the generic text */ }
      setStreamErr({ message })
    })
    return () => es.close()
  }, [jobId, conn, loadJob])

  useEffect(() => {
    const el = logRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
  }, [lines])

  const failed = job?.status === "failed"
  const succeeded = job?.status === "succeeded"
  const active = job ? isActiveJobStatus(job.status) : true
  const removal = job ? isRemovalKind(job.kind) : false
  const mayAct = viewer.isAdmin || (!removal && !!job && job.createdBy === viewer.userId)
  const noActReason = removal ? "ต้องเป็น Admin" : "เฉพาะผู้สร้างงานหรือ Admin"
  const isInstall = job?.kind === "install" || job?.kind === "clone"
  const progress = parseProgress(lines.map((l) => (l.type === "log" && l.msg ? l.msg : "")))

  async function post(path: string): Promise<Response | null> {
    setBusy(true); setActionErr(null)
    try {
      const res = await apiFetch(path, { method: "POST" })
      if (!res.ok) { setActionErr(await readApiError(res)); return null }
      return res
    } catch {
      setActionErr(NET)
      return null
    } finally {
      setBusy(false)
    }
  }
  const badReply: ApiError = { message: "เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง ระบบโหลดสถานะงานใหม่ให้แล้ว ลองอีกครั้ง" }
  async function readJobId(res: Response): Promise<string | null> {
    const b = (await res.json().catch(() => null)) as { jobId?: unknown } | null
    return typeof b?.jobId === "string" && b.jobId ? b.jobId : null
  }
  async function retry() {
    const res = await post(`/jobs/${encodeURIComponent(jobId)}/retry`)
    if (!res) return
    const id = await readJobId(res)
    terminal.current = false // a retry legitimately moves a failed job back to running
    latest.current.next() // drop any in-flight status response from before the retry
    if (id === null) { setActionErr(badReply); void loadJob(); return }
    setJob((j) => (j ? { ...j, status: "running", error: null } : j))
    if (id !== jobId) onJobChange(id)
    else reconnect()
  }
  async function cancel() {
    const res = await post(`/jobs/${encodeURIComponent(jobId)}/cancel`)
    setConfirmCancel(false)
    if (!res) return
    const id = await readJobId(res)
    if (id === null) { setActionErr(badReply); void loadJob(); return }
    if (id !== jobId) onJobChange(id)
    else reconnect()
  }

  const idx = job ? job.stages.indexOf(job.stage) : -1
  const stageState = (i: number): "done" | "run" | "fail" | "wait" => {
    if (!job) return "wait"
    if (succeeded) return "done"
    if (i < idx) return "done"
    if (i === idx) return failed || job.status === "cancelled" ? "fail" : "run"
    return "wait"
  }
  const heading = !job ? "กำลังโหลด..."
    : succeeded ? (isInstall ? "ติดตั้งเสร็จแล้ว" : "เสร็จเรียบร้อย")
    : failed ? (removal ? "ลบไม่สำเร็จ" : "ติดตั้งไม่สำเร็จ")
    : job.status === "cancelled" ? "ยกเลิกแล้ว"
    : removal ? "กำลังลบ..."
    : "กำลังติดตั้ง..."

  return (
    <div className="space-y-4">
      <div role="status" aria-live="polite" className="sr-only">
        {job ? `${heading}${job.stage && active ? `: ${jobStageLabel(job.stage)}` : ""}${failed && job.error ? `: ${job.error}` : ""}` : ""}
      </div>
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-neutral-100">{heading}</h3>
        {job && <p className="mt-0.5 text-sm text-gray-600">MID: <span className="font-mono">{job.midName}</span></p>}
        {active && <p className="mt-0.5 text-xs text-gray-500">ปิดหน้านี้ได้ งานจะทำต่อบนเซิร์ฟเวอร์ และกลับมาดูได้จากรายการ MID</p>}
      </div>

      {loadErr && <ErrorNotice error={loadErr} />}

      {job && (
        <ol aria-label="ขั้นตอน" className="space-y-1.5">
          {job.stages.map((s, i) => {
            const st = stageState(i)
            return (
              <li key={s} className="flex items-center gap-3 text-sm">
                <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {st === "done" && <span className="font-bold text-emerald-600">✓</span>}
                  {st === "fail" && <span className="font-bold text-red-600">✗</span>}
                  {st === "run" && <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />}
                  {st === "wait" && <span className="h-2 w-2 rounded-full bg-gray-300" />}
                </span>
                <span className="sr-only">{st === "done" ? "เสร็จ" : st === "fail" ? "ล้มเหลว" : st === "run" ? "กำลังทำ" : "รอ"}:</span>
                <span className={st === "wait" ? "text-gray-500" : st === "fail" ? "font-medium text-red-700" : "text-gray-900 dark:text-neutral-100"}>{jobStageLabel(s)}</span>
                {s === "fetchPackage" && st === "run" && progress !== null && (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span role="progressbar" aria-label="ดาวน์โหลด" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="h-2 min-w-0 max-w-48 flex-1 overflow-hidden rounded-full bg-gray-200">
                      <span className="block h-full bg-blue-600" style={{ width: `${progress}%` }} />
                    </span>
                    <span className="text-xs tabular-nums text-gray-600">{progress}%</span>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {streamErr && (
        <div className="space-y-2">
          <ErrorNotice error={streamErr} />
          <button type="button" onClick={() => reconnect()} className={ghostBtnCls}>เชื่อมต่อใหม่</button>
        </div>
      )}

      {failed && (
        <div className="space-y-3">
          <ErrorNotice error={{
            message: job?.error ?? "งานล้มเหลว",
            detail: [...lines].reverse().find((l) => l.type === "error")?.detail,
          }} />
          {!mayAct && <p role="status" className="text-sm text-amber-700">ลองใหม่หรือยกเลิกไม่ได้: {noActReason}</p>}
          {mayAct && <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void retry()} className="btn-primary px-4 py-2 text-sm font-medium">ลองใหม่</button>
            {!removal && <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)} className={ghostBtnCls}>ยกเลิกและลบ</button>}
          </div>}
          {mayAct && <p className="text-xs text-gray-500">“ลองใหม่” ทำต่อจากขั้นที่ล้มเหลว{!removal && " · “ยกเลิกและลบ” ลบ MID ที่ติดตั้งค้างไว้ทั้งหมด"}</p>}
        </div>
      )}
      {actionErr && <ErrorNotice error={actionErr} />}

      {succeeded && isInstall && (
        <div className="space-y-3 rounded-lg border border-green-100 bg-green-100 px-3 py-3 text-sm text-green-800">
          <p>MID ติดตั้งและเชื่อมต่อแล้ว ตรวจสถานะ Validate ใน ServiceNow เพื่อให้ MID พร้อมใช้งาน</p>
          {targetErr && <p role="alert" className="text-xs text-red-700">หาที่อยู่ instance เพื่อสร้างลิงก์ Validate ไม่ได้ เปิด ServiceNow แล้วค้นหา MID ชื่อ “{target?.sn}” ในรายการ MID Server เอง</p>}
          <div className="flex flex-wrap gap-2">
            {target?.url && (
              <a href={`${target.url}ecc_agent_list.do?sysparm_query=name=${encodeURIComponent(target.sn)}`} target="_blank" rel="noopener noreferrer"
                className="btn-primary inline-block px-4 py-2 text-sm font-medium">
                ไป Validate MID ใน instance
              </a>
            )}
            <button type="button" onClick={() => onOpenMid(job!.midName)} className={ghostBtnCls}>ไปที่ MID นี้</button>
          </div>
        </div>
      )}
      {succeeded && !isInstall && (
        <button type="button" onClick={onClose} className="btn-primary px-4 py-2 text-sm font-medium">ปิด</button>
      )}

      <div>
        <p className="mb-1 text-xs font-medium text-gray-600">บันทึกการทำงาน</p>
        <ul ref={logRef} tabIndex={0} aria-label="บันทึกการทำงาน" className="max-h-48 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-2 font-mono text-xs">
          {lines.length === 0 && <li className="text-gray-500">รอข้อมูล...</li>}
          {lines.map((l, i) => {
            const t = lineText(l)
            if (t === null) return null
            const cls = l.level === "error" || l.type === "error" ? "text-red-700" : l.level === "warn" ? "text-amber-800" : "text-gray-800"
            return <li key={i} className={`whitespace-pre-wrap break-all ${cls}`}>{t}</li>
          })}
        </ul>
      </div>

      {confirmCancel && (
        <ConfirmDialog title="ยกเลิกและลบ MID นี้?" confirmLabel="ยกเลิกและลบ" danger busy={busy} onConfirm={() => void cancel()} onCancel={() => setConfirmCancel(false)}>
          ระบบจะหยุดและลบ MID <span className="font-mono">{job?.midName}</span> ที่ติดตั้งค้างไว้ รวมถึงไฟล์ทั้งหมดของมัน
        </ConfirmDialog>
      )}
    </div>
  )
}
