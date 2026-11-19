"use client"

import { useId, useRef, useState } from "react"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"

export const AGENT_ACCESS_LABEL = "AgentHub Access"
export const AGENT_ACCESS_NOTE = "น้อง Java ใน AgentHub จะแก้ไฟล์ของ MID นี้ได้ เมื่อ session ทำงานกับ instance เดียวกัน"

type Props = {
  midName: string
  /** Server value (from the polled MID list). */
  enabled: boolean
  /** Visible reason the switch cannot be changed right now (e.g. a lifecycle job is active). */
  disabledReason?: string | null
  onChanged: () => void
}

/** Per-MID AgentHub opt-in. Optimistic: flips at once, reverts and shows the error when the PATCH fails. */
export function AgentAccessSwitch({ midName, enabled, disabledReason = null, onChanged }: Props) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [err, setErr] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const labelId = useId()
  const noteId = useId()
  // The optimistic value is dropped as soon as the server value catches up with it.
  if (optimistic !== null && optimistic === enabled && !saving) setOptimistic(null)
  const on = optimistic ?? enabled

  async function toggle() {
    if (inFlight.current || disabledReason) return
    const next = !on
    inFlight.current = true
    setErr(null); setOptimistic(next); setSaving(true)
    try {
      const res = await apiFetch(`/mids/${encodeURIComponent(midName)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentAccess: next }),
      })
      if (res.ok) { onChanged(); return }
      setOptimistic(null); setErr(await readApiError(res))
    } catch {
      setOptimistic(null); setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <button type="button" role="switch" aria-checked={on} aria-labelledby={labelId}
          aria-describedby={`${noteId}${disabledReason ? " agent-access-reason" : ""}`}
          disabled={!!disabledReason} onClick={() => void toggle()}
          className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${on ? "border-brand-sky bg-brand-sky" : "border-gray-300 bg-gray-200 dark:border-neutral-600 dark:bg-neutral-700"}`}>
          <span aria-hidden className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">
            <span id={labelId}>{AGENT_ACCESS_LABEL}</span> <span className={`ml-1 text-xs font-semibold ${on ? "text-brand-navy dark:text-brand-sky-soft" : "text-gray-500"}`}>{on ? "On" : "Off"}</span>
          </p>
          <p id={noteId} className="mt-0.5 text-xs text-gray-500">
            {on ? AGENT_ACCESS_NOTE : "ปิดอยู่: AgentHub จะแก้ไฟล์ของ MID นี้ไม่ได้"} · ต้องใช้ session ที่ SN_INSTANCE_URL ตรงกับ instance ของ MID
          </p>
          {disabledReason && <p id="agent-access-reason" className="mt-0.5 text-xs text-amber-700">{disabledReason}</p>}
        </div>
      </div>
      {err && <ErrorNotice error={err} />}
    </div>
  )
}
