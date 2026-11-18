"use client"

import { useCallback, useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ImportMidDialog } from "./ImportMidDialog"
import { MidList } from "./MidList"
import { MidPanel } from "./MidPanel"
import { TopBar } from "./TopBar"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import type { HostView, MidView } from "@/lib/ui/status-view"

const POLL_MS = 5000
const API = "/midhub/api"

export function Dashboard({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const selected = params.get("mid")

  const [mids, setMids] = useState<MidView[] | null>(null)
  const [host, setHost] = useState<HostView | null>(null)
  const [err, setErr] = useState<ApiError | null>(null)
  const [importing, setImporting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([fetch(`${API}/mids`), fetch(`${API}/host`)])
      if (m.status === 401 || h.status === 401) { router.replace("/login"); return }
      if (m.ok) { setMids((await m.json()) as MidView[]); setErr(null) } else setErr(await readApiError(m))
      if (h.ok) setHost((await h.json()) as HostView)
    } catch {
      setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่าย ระบบจะลองใหม่อัตโนมัติ" })
    }
  }, [router])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => { if (!timer) { void refresh(); timer = setInterval(() => void refresh(), POLL_MS) } }
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }
    const onVis = () => (document.visibilityState === "visible" ? start() : stop())
    onVis()
    document.addEventListener("visibilitychange", onVis)
    return () => { stop(); document.removeEventListener("visibilitychange", onVis) }
  }, [refresh])

  const select = useCallback((name: string | null) => {
    router.replace(name ? `${pathname}?mid=${encodeURIComponent(name)}` : pathname)
  }, [router, pathname])

  const current = mids?.find((m) => m.name === selected) ?? null

  return (
    <div className="min-h-screen bg-gray-50">
      <TopBar email={email} isAdmin={isAdmin} host={host} mids={mids ?? []} onImport={() => setImporting(true)} />
      <main className="mx-auto max-w-6xl p-4">
        {err && <div className="mb-4"><ErrorNotice error={err} /></div>}
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
          <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
            <nav aria-label="MID" className="rounded-xl border border-gray-200 bg-white p-2">
              <MidList mids={mids} selected={selected} onSelect={select} />
            </nav>
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              {current
                ? <MidPanel key={current.name} mid={current} host={host} onChanged={() => void refresh()} />
                : <p className="text-sm text-gray-500">เลือก MID จากรายการด้านซ้ายเพื่อดูรายละเอียด</p>}
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
