"use client"

import { useRef, useState } from "react"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { JobProgress } from "./JobProgress"
import { Modal } from "./Modal"
import { apiFetch } from "@/lib/ui/api"
import { ghostBtnCls, inputCls } from "@/lib/ui/classes"
import { instanceRecordUrl } from "@/lib/ui/record-link"

type Props = {
  /** Snapshot taken when the dialog opened: the MID disappears from the list while its uninstall job is still shown. */
  mid: { name: string; instanceUrl: string | null; midName: string | null }
  /** Resume mode: show this (already running or failed) uninstall job and skip the typing step. */
  jobId?: string | null
  /** `jobId` is the job shown when the dialog closed (null if none was started). */
  viewer: { isAdmin: boolean; userId: string }
  onClose: (jobId: string | null) => void
  /** The uninstall job was accepted (host refreshes the list). */
  onStarted?: () => void
}

const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }

export function UninstallDialog({ mid, jobId: initialJobId = null, onClose: close, onStarted, viewer }: Props) {
  const [typed, setTyped] = useState("")
  const [jobId, setJobId] = useState<string | null>(initialJobId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)
  const [done, setDone] = useState(false)
  const inFlight = useRef(false)
  const onClose = () => close(jobId)

  const matches = typed === mid.name // exact: case-sensitive, not trimmed
  const record = instanceRecordUrl(mid.instanceUrl, mid.midName ?? mid.name)

  async function submit() {
    if (!matches || inFlight.current) return
    inFlight.current = true
    setBusy(true); setErr(null)
    try {
      const res = await apiFetch(`/mids/${encodeURIComponent(mid.name)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmName: typed }),
      })
      if (!res.ok) { setErr(await readApiError(res)); return }
      const b = (await res.json().catch(() => null)) as { jobId?: unknown } | null
      if (typeof b?.jobId !== "string" || !b.jobId) {
        setErr({ message: "เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง ตรวจสถานะ MID ในรายการแล้วลองใหม่" })
        onStarted?.()
        return
      }
      setJobId(b.jobId)
      onStarted?.()
    } catch {
      setErr(NET)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal labelledBy="uninstall-title" onClose={onClose} busy={busy}>
      <h2 id="uninstall-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-100">
        {jobId ? `Uninstall ${mid.name}` : `Uninstall MID ${mid.name}?`}
      </h2>
      {jobId === null ? (
        <form className="mt-2 space-y-3 text-sm text-gray-700" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <p>ระบบจะหยุดและถอนบริการของ MID นี้ แล้วเก็บไฟล์ที่แก้ไขได้ไว้ใน archive ชั่วคราวก่อนลบโฟลเดอร์</p>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            record ของ MID นี้ใน ServiceNow instance <strong>ไม่ถูกลบ</strong> ต้องลบเองใน instance ถ้าไม่ใช้แล้ว
          </p>
          <label className="block">
            พิมพ์ชื่อ MID <span className="font-mono font-semibold">{mid.name}</span> เพื่อยืนยัน
            <input data-autofocus value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy}
              autoComplete="off" autoCapitalize="off" spellCheck={false} className={`mt-1 font-mono ${inputCls}`} />
          </label>
          {err && <ErrorNotice error={err} />}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy} className={ghostBtnCls}>Cancel</button>
            <button type="submit" disabled={!matches || busy}
              className="rounded-[10px] bg-danger px-4 py-2 text-sm font-semibold text-white hover:bg-danger-press disabled:opacity-50">
              {busy ? "Working…" : "Uninstall"}
            </button>
          </div>
          {!matches && <p className="text-xs text-gray-500">ปุ่มลบจะใช้ได้เมื่อพิมพ์ชื่อตรงทุกตัวอักษร (ตัวพิมพ์เล็ก/ใหญ่ต้องตรง)</p>}
        </form>
      ) : (
        <div className="mt-3 space-y-4">
          <JobProgress key={jobId} viewer={viewer} jobId={jobId} onJobChange={(id) => { setDone(false); setJobId(id) }} onOpenMid={() => onClose()} onClose={onClose}
            onStatus={(j) => setDone(j.kind === "uninstall" && j.status === "succeeded")} />
          {done && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p>ลบ record นี้ใน instance เองถ้าไม่ใช้แล้ว</p>
              {record
                ? <a href={record} target="_blank" rel="noopener noreferrer" className="inline-block break-all text-blue-700 underline">Open in ServiceNow</a>
                : <p className="text-xs">หา record ใน ServiceNow ได้ที่ MID Server ชื่อ “{mid.midName ?? mid.name}”</p>}
            </div>
          )}
          {!done && <div className="flex justify-end"><button type="button" onClick={onClose} className={ghostBtnCls}>Close</button></div>}
        </div>
      )}
    </Modal>
  )
}
