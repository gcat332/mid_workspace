"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/ui/api"
import { inputCls, labelCls, ghostBtnCls } from "@/lib/ui/classes"
import { MID_NAME_RE } from "@/lib/mids/name-regex"
import type { MidView } from "@/lib/ui/status-view"
import type { NameResult, WizardState } from "@/lib/ui/wizard"

export type ExtraDraft = { cloneFrom: string; proxyUser: string; proxyPass: string; snTouched: boolean }
type Props = {
  state: WizardState
  extra: ExtraDraft
  mids: MidView[]
  onChange: (p: Partial<WizardState>) => void
  onExtra: (p: Partial<ExtraDraft>) => void
  nameResult: NameResult | null
  onNameResult: (r: NameResult | null) => void
}
const DEBOUNCE_MS = 300

export function SettingsStep({ state, extra, mids, onChange, onExtra, nameResult, onNameResult }: Props) {
  const [advanced, setAdvanced] = useState(false)
  const [recheck, setRecheck] = useState(0)
  const { name } = state

  // 300 ms debounced availability check; an answer for an older name is ignored (deriveNameCheck).
  useEffect(() => {
    if (!name || !MID_NAME_RE.test(name)) return
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/mids/name-check?name=${encodeURIComponent(name)}`)
        const j = (await res.json().catch(() => null)) as { available?: boolean; message?: string } | null
        if (!res.ok || !j) onNameResult({ name, status: "error" })
        else onNameResult({ name, status: j.available ? "available" : "taken", message: j.message })
      } catch {
        onNameResult({ name, status: "error" })
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [name, recheck, onNameResult])

  const setName = (v: string) => {
    const n = v.trim().toLowerCase()
    onChange({ name: n, ...(extra.snTouched ? {} : { snName: n ? `midhub-${n}` : "" }) })
  }
  const cloneable = mids.filter((m) => m.state !== "removed" && m.state !== "installing" && m.state !== "uninstalling")

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-neutral-100">ตั้งค่า MID</h3>
        <p className="mt-0.5 text-sm text-gray-600">ตั้งแค่ชื่อก็พอ ที่เหลือใช้ค่าเริ่มต้นได้เลย</p>
      </div>

      <div>
        <label className={labelCls} htmlFor="w-name">ชื่อ MID (ชื่อโฟลเดอร์บนเครื่อง)</label>
        <div className="flex gap-2">
          <input id="w-name" data-autofocus className={`${inputCls} font-mono`} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="เช่น demo-mid-1" autoComplete="off" spellCheck={false} aria-describedby="w-name-msg" aria-invalid={state.nameCheck === "invalid" || state.nameCheck === "taken" || state.nameCheck === "error"} />
          {state.nameCheck === "error" && <button type="button" onClick={() => { onNameResult(null); setRecheck((n) => n + 1) }} className={`${ghostBtnCls} shrink-0`}>ตรวจอีกครั้ง</button>}
        </div>
        <p id="w-name-msg" aria-live="polite" className="mt-1 min-h-4 text-xs">
          {state.nameCheck === "checking" && <span className="text-gray-500">กำลังตรวจสอบชื่อ...</span>}
          {state.nameCheck === "available" && <span className="text-emerald-700">✓ ชื่อนี้ใช้ได้</span>}
          {state.nameCheck === "taken" && <span className="text-red-600">{nameResult?.message ?? "มี MID ชื่อนี้อยู่แล้ว ใช้ชื่ออื่น"}</span>}
          {state.nameCheck === "invalid" && <span className="text-red-600">ใช้ได้เฉพาะ a-z, 0-9 และ - (2-40 ตัวอักษร ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)</span>}
          {state.nameCheck === "error" && <span className="text-red-600">ตรวจชื่อไม่สำเร็จ ลองใหม่อีกครั้ง</span>}
        </p>
      </div>

      <div>
        <label className={labelCls} htmlFor="w-sn">ชื่อ MID ใน ServiceNow</label>
        <input id="w-sn" className={`${inputCls} font-mono`} value={state.snName} spellCheck={false}
          onChange={(e) => { onExtra({ snTouched: true }); onChange({ snName: e.target.value.trim() }) }} />
        <p className="mt-1 text-xs text-gray-500">ชื่อที่จะเห็นในรายการ MID Server ของ ServiceNow (ค่าเริ่มต้น midhub-ชื่อ MID)</p>
      </div>

      <div>
        <label className={labelCls} htmlFor="w-clone">Clone จาก MID ที่มีอยู่ (ไม่บังคับ)</label>
        <select id="w-clone" className={inputCls} value={extra.cloneFrom} onChange={(e) => onExtra({ cloneFrom: e.target.value })}>
          <option value="">ไม่ clone (ติดตั้งใหม่ทั้งหมด)</option>
          {cloneable.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
        <p className="mt-1 text-xs text-gray-500">คัดลอก extlib, สคริปต์ และไฟล์เสริมจาก MID ต้นทาง (ไม่คัดลอกรหัส/ค่าเชื่อมต่อ)</p>
      </div>

      <div>
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="text-sm font-medium text-blue-700 underline">
          {advanced ? "ซ่อนตั้งค่าขั้นสูง" : "ตั้งค่าขั้นสูง (proxy, heap, log)"}
        </button>
        {advanced && (
          <div className="mt-3 space-y-3 rounded-lg border border-gray-200 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="w-heap">Heap (MB)</label>
                <input id="w-heap" className={inputCls} inputMode="numeric" value={state.heapMb} onChange={(e) => onChange({ heapMb: e.target.value })} />
              </div>
              <div>
                <label className={labelCls} htmlFor="w-logs">จำนวนไฟล์ log (1-10)</label>
                <input id="w-logs" className={inputCls} inputMode="numeric" value={state.logFiles} onChange={(e) => onChange({ logFiles: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-neutral-100">
              <input type="checkbox" checked={state.proxyOn} onChange={(e) => onChange({ proxyOn: e.target.checked })} />
              ใช้ proxy ออกอินเทอร์เน็ต
            </label>
            {state.proxyOn && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls} htmlFor="w-ph">Proxy host</label>
                  <input id="w-ph" className={inputCls} value={state.proxyHost} onChange={(e) => onChange({ proxyHost: e.target.value.trim() })} /></div>
                <div><label className={labelCls} htmlFor="w-pp">Proxy port</label>
                  <input id="w-pp" className={inputCls} inputMode="numeric" value={state.proxyPort} onChange={(e) => onChange({ proxyPort: e.target.value })} /></div>
                <div><label className={labelCls} htmlFor="w-pu">Proxy user (ถ้ามี)</label>
                  <input id="w-pu" className={inputCls} value={extra.proxyUser} autoComplete="off" onChange={(e) => onExtra({ proxyUser: e.target.value })} /></div>
                <div><label className={labelCls} htmlFor="w-pw">Proxy password (ถ้ามี)</label>
                  <input id="w-pw" className={inputCls} type="password" value={extra.proxyPass} autoComplete="new-password" onChange={(e) => onExtra({ proxyPass: e.target.value })} /></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
