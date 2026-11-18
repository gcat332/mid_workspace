"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ImportMidDialog } from "./ImportMidDialog"
import { MidList } from "./MidList"
import { MidPanel } from "./MidPanel"
import { TopBar } from "./TopBar"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { createLatest } from "@/lib/ui/latest"
import type { HostView, MidView } from "@/lib/ui/status-view"

const POLL_MS = 5000
// Polls are not user activity: the proxy does not slide the session for them, so the 4 h idle timeout still fires.
const BACKGROUND: RequestInit = { headers: { "X-Background": "1" } }

export function Dashboard({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const selected = params.get("mid")
  const forbidden = params.get("notice") === "forbidden"

  const [mids, setMids] = useState<MidView[] | null>(null)
  const [host, setHost] = useState<HostView | null>(null)
  const [midsErr, setMidsErr] = useState<ApiError | null>(null)
  const [hostErr, setHostErr] = useState<ApiError | null>(null)
  const [importing, setImporting] = useState(false)

  const latest = useRef(createLatest())

  const refresh = useCallback(async () => {
    const token = latest.current.next()
    const load = async <T,>(path: string, what: string): Promise<{ data?: T; err?: ApiError }> => {
      let res: Response
      try {
        res = await apiFetch(path, BACKGROUND)
      } catch {
        return { err: { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่าย ระบบจะลองใหม่อัตโนมัติ" } }
      }
      if (!res.ok) return { err: await readApiError(res) }
      try {
        return { data: (await res.json()) as T }
      } catch {
        return { err: { message: `อ่านข้อมูล${what}จากเซิร์ฟเวอร์ไม่ได้ ลองรีเฟรชหน้า`, detail: "invalid JSON" } }
      }
    }
    const [m, h] = await Promise.all([load<MidView[]>("/mids", "MID"), load<HostView>("/host", "สถานะเครื่อง")])
    if (!latest.current.isCurrent(token)) return // a newer refresh started; this response is stale
    if (m.data) setMids(m.data)
    setMidsErr(m.err ?? null)
    // Host unknown must not leave stale quota behind: Start is disabled while host is null.
    setHost(h.data ?? null)
    setHostErr(h.err ? { ...h.err, message: `อ่านสถานะเครื่องไม่ได้ (RAM/โควต้า): ${h.err.message}` } : null)
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => { if (!timer) { void refresh(); timer = setInterval(() => void refresh(), POLL_MS) } }
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }
    const onVis = () => (document.visibilityState === "visible" ? start() : stop())
    onVis()
    document.addEventListener("visibilitychange", onVis)
    return () => { stop(); document.removeEventListener("visibilitychange", onVis) }
  }, [refresh])

  const panelRef = useRef<HTMLDivElement>(null)
  const select = useCallback((name: string | null) => {
    // scroll:false - Next would otherwise jump to the top, undoing the mobile scroll below.
    router.replace(name ? `${pathname}?mid=${encodeURIComponent(name)}` : pathname, { scroll: false })
  }, [router, pathname])
  // On a phone the panel sits below the list: bring it into view after a tap.
  const pick = useCallback((name: string) => {
    select(name)
    if (window.matchMedia("(max-width: 767px)").matches) {
      setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150)
    }
  }, [select])

  const current = mids?.find((m) => m.name === selected) ?? null

  return (
    <div className="min-h-screen bg-gray-50">
      <TopBar email={email} isAdmin={isAdmin} host={host} mids={mids ?? []} onImport={() => setImporting(true)} />
      <main className="mx-auto max-w-6xl p-4">
        {forbidden && (
          <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p>หน้านั้นสำหรับ Admin เท่านั้น (ต้องเป็น Admin) หากต้องการสิทธิ์ ให้ติดต่อ Admin ของ MidHub</p>
            <button type="button" onClick={() => router.replace(selected ? `${pathname}?mid=${encodeURIComponent(selected)}` : pathname)}
              className="ml-auto shrink-0 text-amber-800 underline">ปิด</button>
          </div>
        )}
        {midsErr && <div className="mb-4"><ErrorNotice error={midsErr} /></div>}
        {hostErr && <div className="mb-4"><ErrorNotice error={hostErr} /></div>}
        {mids === null ? (
          <p className="text-sm text-gray-500">กำลังโหลด...</p>
        ) : mids.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center">
            <p className="text-lg font-medium text-gray-900">ยังไม่มี MID Server</p>
            <p className="mt-2 text-sm text-gray-600">ถ้ามี MID ที่ติดตั้งไว้บนเครื่องนี้แล้ว กดปุ่มด้านล่างเพื่อนำเข้ามาจัดการได้เลย</p>
            <button type="button" onClick={() => setImporting(true)}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Import MID ที่มีอยู่
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
            <nav aria-label="MID" className="min-w-0 rounded-xl border border-gray-200 bg-white p-2">
              <MidList mids={mids} selected={selected} onSelect={pick} />
            </nav>
            <div ref={panelRef} className="min-w-0 scroll-mt-4 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
              {current
                ? <MidPanel key={current.name} mid={current} host={host} onChanged={() => void refresh()} />
                : <p className="text-sm text-gray-500">เลือก MID จากรายการเพื่อดูรายละเอียด</p>}
            </div>
          </div>
        )}
      </main>
      {importing && (
        <ImportMidDialog onCancel={() => setImporting(false)}
          onDone={(name) => { setImporting(false); void refresh(); select(name) }} />
      )}
    </div>
  )
}
