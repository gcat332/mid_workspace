"use client"

import { useEffect, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { wouldAllow, isLoopback } from "@/lib/net/cidr"
import { inputCls, tableCardCls, theadCls, trHoverCls } from "@/lib/ui/classes"

type Entry = { id: string; cidr: string; note: string; createdAt: string }
type Pending = { title: string; body: string; confirmLabel: string; run: () => Promise<void> }

const input = inputCls.replace("w-full ", "")
const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }

export function IpAllowlistManager() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [myIp, setMyIp] = useState("")
  const [cidr, setCidr] = useState("")
  const [note, setNote] = useState("")
  const [err, setErr] = useState<ApiError | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)

  const [reload, setReload] = useState(0)
  useEffect(() => {
    apiFetch("/admin/ip-allowlist")
      .then(async (r) => {
        if (!r.ok) { setErr(await readApiError(r)); return }
        const j = (await r.json()) as { entries: Entry[]; myIp: string }
        setEntries(j.entries); setMyIp(j.myIp)
      })
      .catch(() => setErr(NET))
  }, [reload])
  const load = () => setReload((n) => n + 1)

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setErr(null); setBusy(true)
    try {
      const res = await apiFetch(path, init)
      if (!res.ok) { setErr(await readApiError(res)); return false }
      load()
      return true
    } catch {
      setErr(NET)
      return false
    } finally {
      setBusy(false)
    }
  }

  // A change that leaves the list non-empty without the admin's own IP locks them out on the next request.
  const locksMeOut = (next: string[]) => !!myIp && !isLoopback(myIp) && !wouldAllow(myIp, next)
  const lockoutText = `หลังการเปลี่ยนแปลงนี้ IP ของคุณ (${myIp}) จะไม่อยู่ในรายการ และจะเข้าใช้งานไม่ได้ (403) ต้องแก้ที่เซิร์ฟเวอร์`

  async function doAdd() {
    if (await call("/admin/ip-allowlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cidr, note }) })) {
      setCidr(""); setNote("")
    }
  }
  function add() {
    setErr(null)
    if (!locksMeOut([...entries.map((e) => e.cidr), cidr.trim()])) { void doAdd(); return }
    setPending({ title: "Your IP Will Be Blocked", body: `${lockoutText} ต้องการเพิ่ม ${cidr.trim()} ต่อหรือไม่?`, confirmLabel: "Add Anyway", run: doAdd })
  }
  function remove(e: Entry) {
    setErr(null)
    const lockout = locksMeOut(entries.filter((x) => x.id !== e.id).map((x) => x.cidr))
    setPending({
      title: `Delete ${e.cidr}?`,
      body: lockout ? lockoutText : "IP ในช่วงนี้จะเข้าใช้งานไม่ได้อีก (ถ้ายังมีรายการอื่นเหลืออยู่)",
      confirmLabel: "Delete",
      run: async () => { await call(`/admin/ip-allowlist?id=${encodeURIComponent(e.id)}`, { method: "DELETE" }) },
    })
  }

  return (
    <section>
      <h1 className="mb-2 text-lg font-semibold text-gray-900">IP Allowlist</h1>
      <p className="mb-4 text-sm text-gray-600">
        ถ้ารายการว่าง อนุญาตทุก IP; เมื่อมีรายการ เฉพาะ IP/CIDR ในรายการเท่านั้นที่เข้าใช้งานได้ (รองรับ IPv4 และ IPv6)
      </p>
      {myIp && !isLoopback(myIp) && (
        <p className="mb-3 text-xs text-gray-600">
          IP ของคุณที่เซิร์ฟเวอร์เห็น: <span className="font-mono text-gray-900">{myIp}</span>{" "}
          ({wouldAllow(myIp, entries.map((e) => e.cidr)) ? "Allowed" : "Not Listed"}){" "}
          <button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setCidr(myIp)}>Use This IP</button>
        </p>
      )}
      <form className="mb-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="1.2.3.4, 10.0.0.0/24 or 2001:db8::/32"
          aria-label="IP or CIDR" className={`${input} min-w-[200px] flex-1`} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (Optional)"
          aria-label="Note" className={`${input} min-w-[140px] flex-1`} />
        <button type="submit" disabled={busy} className="btn-primary px-4 py-2 text-sm font-medium">Add</button>
      </form>
      {err && <div className="mb-2"><ErrorNotice error={err} /></div>}
      <div className={tableCardCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}>
            <tr><th className="px-4 py-2 font-medium">IP / CIDR</th><th className="px-4 py-2 font-medium">Note</th><th className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {entries.map((e) => (
              <tr key={e.id} className={trHoverCls}>
                <td className="px-4 py-2 font-mono text-gray-900">{e.cidr}</td>
                <td className="px-4 py-2 text-gray-500">{e.note || "—"}</td>
                <td className="px-4 py-2 text-right">
                  <button type="button" className="text-red-600 hover:underline" onClick={() => remove(e)}>Delete</button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">ไม่มีข้อจำกัด IP — อนุญาตทุกที่อยู่</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pending && (
        <ConfirmDialog title={pending.title} confirmLabel={pending.confirmLabel} danger busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void pending.run().then(() => setPending(null))}>
          {pending.body}
        </ConfirmDialog>
      )}
    </section>
  )
}
