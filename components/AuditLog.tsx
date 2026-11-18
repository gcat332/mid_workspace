"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "@/lib/ui/api"
import { ErrorNotice, readApiError, type ApiError } from "@/components/ErrorNotice"
import { actionLabel, compactDetail, detailPairs } from "@/lib/ui/audit-format"

type Item = { id: string; at: string; email: string; action: string; midName: string | null; detail: string }

const bangkok = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})
/** `YYYY-MM-DD HH:mm:ss` in Asia/Bangkok. */
export const formatBangkok = (iso: string): string => bangkok.format(new Date(iso))

const input = "rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"

/** Readable "label: value" lines; the full JSON stays one click away. */
function Detail({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false)
  const pairs = detailPairs(detail)
  if (pairs !== null && pairs.length === 0) return <span className="text-gray-400">-</span>
  return (
    <div className="text-xs text-gray-700">
      {pairs ? (
        <dl className="space-y-0.5">
          {pairs.map(([k, v], i) => (
            <div key={i} className="flex gap-1">
              <dt className="shrink-0 text-gray-500">{k}:</dt>
              <dd className="min-w-0 break-all text-gray-900">{v}</dd>
            </div>
          ))}
        </dl>
      ) : <span className="break-all font-mono">{detail}</span>}
      {pairs && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
            className="mt-0.5 text-blue-600 hover:underline">
            {open ? "ซ่อน JSON" : "ดู JSON เต็ม"}
          </button>
          {open && <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-gray-50 p-1.5 font-mono text-gray-700">{compactDetail(detail)}</pre>}
        </>
      )}
    </div>
  )
}

export function AuditLog() {
  const [mid, setMid] = useState("")
  const [user, setUser] = useState("")
  const [items, setItems] = useState<Item[]>([])
  // The cursor is only valid with the filters it was issued for, so they travel together.
  const [next, setNext] = useState<{ cursor: string; mid: string; user: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (m: string, u: string, cursor: string | null) => {
    const mySeq = ++seq.current // a newer filter/page request supersedes this one
    setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams()
      if (m.trim()) qs.set("mid", m.trim())
      if (u.trim()) qs.set("user", u.trim())
      if (cursor) qs.set("cursor", cursor)
      const res = await apiFetch(`/admin/audit?${qs}`)
      if (mySeq !== seq.current) return
      if (!res.ok) { setError(await readApiError(res)); return }
      const j = (await res.json()) as { items: Item[]; nextCursor: string | null }
      if (mySeq !== seq.current) return
      setItems((prev) => (cursor ? [...prev, ...j.items] : j.items))
      setNext(j.nextCursor ? { cursor: j.nextCursor, mid: m, user: u } : null)
    } catch {
      if (mySeq === seq.current) setError({ code: "network", message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally {
      if (mySeq === seq.current) setLoading(false)
    }
  }, [])

  // Debounced: reloads from the first page 300 ms after the last keystroke (also runs on mount).
  useEffect(() => {
    const t = setTimeout(() => { void load(mid, user, null) }, 300)
    return () => clearTimeout(t)
  }, [mid, user, load])

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold text-gray-900">Audit log</h1>
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="text-sm text-gray-700">
          <span className="mb-1 block">MID</span>
          <input className={input} value={mid} maxLength={100} onChange={(e) => setMid(e.target.value)} placeholder="ชื่อ MID ตรงตัว" />
        </label>
        <label className="text-sm text-gray-700">
          <span className="mb-1 block">ผู้ใช้</span>
          <input className={input} value={user} maxLength={100} onChange={(e) => setUser(e.target.value)} placeholder="ส่วนหนึ่งของอีเมล" />
        </label>
      </div>
      {error && <div className="mb-3"><ErrorNotice error={error} /></div>}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2 font-medium">เวลา</th>
              <th className="px-3 py-2 font-medium">ผู้ใช้</th>
              <th className="px-3 py-2 font-medium">การกระทำ</th>
              <th className="px-3 py-2 font-medium">MID</th>
              <th className="px-3 py-2 font-medium">รายละเอียด</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-700">{formatBangkok(r.at)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-900">{r.email}</td>
                <td className="px-3 py-2 text-gray-900">
                  {actionLabel(r.action) ?? <span className="font-mono text-xs">{r.action}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-700">{r.midName ?? <span className="text-gray-400">-</span>}</td>
                <td className="px-3 py-2"><Detail detail={r.detail} /></td>
              </tr>
            ))}
            {!loading && !error && items.length === 0 && !next && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">ไม่พบรายการ</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        {loading && <p className="text-sm text-gray-500" role="status">กำลังโหลด…</p>}
        {!loading && next && (
          <button type="button" onClick={() => void load(next.mid, next.user, next.cursor)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-800 hover:bg-gray-50">
            โหลดเพิ่ม
          </button>
        )}
      </div>
    </section>
  )
}
