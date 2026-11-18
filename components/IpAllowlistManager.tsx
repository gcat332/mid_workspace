"use client"

import { useEffect, useState } from "react"
import { wouldAllow, isLoopback } from "@/lib/net/cidr"

type Entry = { id: string; cidr: string; note: string; createdAt: string }

const API = "/midhub/api/admin/ip-allowlist"
const input = "rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"

export function IpAllowlistManager() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [myIp, setMyIp] = useState("")
  const [cidr, setCidr] = useState("")
  const [note, setNote] = useState("")
  const [err, setErr] = useState("")

  const [reload, setReload] = useState(0)
  useEffect(() => {
    fetch(API)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j: { entries: Entry[]; myIp: string }) => { setEntries(j.entries); setMyIp(j.myIp) })
      .catch(() => setErr("โหลดรายการไม่สำเร็จ ตรวจสอบว่าเข้าสู่ระบบด้วยบัญชี Admin"))
  }, [reload])
  const load = () => setReload((n) => n + 1)

  // A change that leaves the list non-empty without the admin's own IP locks them out on the
  // next request, so ask first.
  const keepsMeIn = (next: string[]) =>
    !myIp || isLoopback(myIp) || wouldAllow(myIp, next) ||
    window.confirm(`หลังการเปลี่ยนแปลงนี้ IP ของคุณ (${myIp}) จะไม่อยู่ในรายการ และจะเข้าใช้งานไม่ได้ (403) ต้องแก้ที่เซิร์ฟเวอร์ ต้องการดำเนินการต่อหรือไม่`)

  async function add() {
    setErr("")
    if (!keepsMeIn([...entries.map((e) => e.cidr), cidr.trim()])) return
    const res = await fetch(API, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cidr, note }),
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setErr(j.error ?? "เพิ่มรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
      return
    }
    setCidr(""); setNote(""); load()
  }

  async function remove(e: Entry) {
    if (!window.confirm(`ลบ ${e.cidr} ออกจากรายการ?`)) return
    if (!keepsMeIn(entries.filter((x) => x.id !== e.id).map((x) => x.cidr))) return
    await fetch(`${API}?id=${encodeURIComponent(e.id)}`, { method: "DELETE" })
    load()
  }

  return (
    <section>
      <h1 className="text-xl font-semibold text-gray-900 mb-2">IP Allowlist</h1>
      <p className="text-sm text-gray-600 mb-4">
        ถ้ารายการว่าง อนุญาตทุก IP; เมื่อมีรายการ เฉพาะ IP/CIDR ในรายการเท่านั้นที่เข้าใช้งานได้ (รองรับ IPv4 และ IPv6)
      </p>
      {myIp && !isLoopback(myIp) && (
        <p className="text-xs text-gray-600 mb-3">
          IP ของคุณที่เซิร์ฟเวอร์เห็น: <span className="font-mono text-gray-900">{myIp}</span>{" "}
          ({wouldAllow(myIp, entries.map((e) => e.cidr)) ? "อนุญาต" : "ไม่อยู่ในรายการ"}){" "}
          <button className="text-blue-600 hover:underline" onClick={() => setCidr(myIp)}>ใช้ IP นี้</button>
        </p>
      )}
      <div className="flex flex-wrap gap-2 mb-3">
        <input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="1.2.3.4 หรือ 10.0.0.0/24 หรือ 2001:db8::/32"
          aria-label="IP หรือ CIDR" className={`${input} flex-1 min-w-[200px]`} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="หมายเหตุ (ไม่บังคับ)"
          aria-label="หมายเหตุ" className={`${input} flex-1 min-w-[140px]`} />
        <button onClick={() => void add()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">เพิ่ม</button>
      </div>
      {err && <p className="text-sm text-red-600 mb-2">{err}</p>}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-600">
            <tr><th className="px-4 py-3">IP / CIDR</th><th className="px-4 py-3">หมายเหตุ</th><th className="px-4 py-3" /></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-3 font-mono text-gray-900">{e.cidr}</td>
                <td className="px-4 py-3 text-gray-500">{e.note || "—"}</td>
                <td className="px-4 py-3 text-right">
                  <button className="text-red-600 hover:underline" onClick={() => void remove(e)}>ลบ</button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">ไม่มีข้อจำกัด IP — อนุญาตทุกที่อยู่</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
