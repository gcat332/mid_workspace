"use client"

import { useState } from "react"
import { Modal } from "./Modal"
import { apiFetch } from "@/lib/ui/api"
import { MID_NAME_RE } from "@/lib/mids/name-regex"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"


export function ImportMidDialog({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)
  const valid = MID_NAME_RE.test(name)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true); setErr(null)
    try {
      const res = await apiFetch("/mids/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })
      if (!res.ok) { setErr(await readApiError(res)); return }
      onDone(name)
    } catch {
      setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal labelledBy="import-title" onClose={onCancel} busy={busy}>
      <form onSubmit={submit}>
        <h2 id="import-title" className="text-lg font-semibold text-gray-900">Import MID ที่มีอยู่</h2>
        <p className="mt-1 text-sm text-gray-600">
          ใส่ชื่อโฟลเดอร์ของ MID บนเครื่อง (โฟลเดอร์ที่อยู่ใน <code className="font-mono">mids/</code> ของ MidHub) แล้ว ระบบจะอ่านค่าจาก config.xml ให้เอง
        </p>
        <label className="mt-3 block text-sm text-gray-800">
          ชื่อ MID
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="เช่น demo-mid-1"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </label>
        {name && !valid && (
          <p className="mt-1 text-xs text-red-600">ใช้ได้เฉพาะ a-z, 0-9 และ - (2-40 ตัวอักษร ขึ้นต้นด้วยตัวอักษรหรือตัวเลข; ตัวพิมพ์ใหญ่จะถูกแปลงเป็นตัวเล็กให้)</p>
        )}
        {err && <div className="mt-3"><ErrorNotice error={err} /></div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">ยกเลิก</button>
          <button type="submit" disabled={!valid || busy}
            className="btn-primary px-4 py-2 text-sm font-medium">
            {busy ? "กำลัง Import..." : "Import"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
