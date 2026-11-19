"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { CreateMidWizard } from "./CreateMidWizard"
import { ImportMidDialog } from "./ImportMidDialog"
import { MidList } from "./MidList"
import { MidPanel } from "./MidPanel"
import { UninstallDialog } from "./UninstallDialog"
import { AppChrome } from "./AppChrome"
import { DashboardToolbar } from "./DashboardToolbar"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { createLatest } from "@/lib/ui/latest"
import { jobIsActive, resumableUninstall, type HostView, type MidView } from "@/lib/ui/status-view"

const POLL_MS = 5000
const DISMISS_KEY = "midhub.uninstall.dismissed"
const OPTIMISTIC_MS = 15000

const memDismissed = new Set<string>() // fallback when sessionStorage is unavailable
function dismissedJobs(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? "[]") as unknown
    return [...(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []), ...memDismissed]
  } catch { return [...memDismissed] }
}
function dismissJob(id: string) {
  try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissedJobs(), id].slice(-50))) } catch { memDismissed.add(id) /* private mode: kept for this page load only */ }
}

const noopSubscribe = () => () => undefined

// Polls are not user activity: the proxy does not slide the session for them, so the 4 h idle timeout still fires.
const BACKGROUND: RequestInit = { headers: { "X-Background": "1" } }

export function Dashboard({ email, userId, isAdmin }: { email: string; userId: string; isAdmin: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const selected = params.get("mid")
  const jobParam = params.get("job")
  // Modal portals into document.body, so a wizard opened by the URL on first load (reload / shared link) waits for hydration.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false)
  const creating = hydrated && (params.get("create") === "1" || jobParam !== null)
  const forbidden = params.get("notice") === "forbidden"

  const [mids, setMids] = useState<MidView[] | null>(null)
  const [host, setHost] = useState<HostView | null>(null)
  const [midsErr, setMidsErr] = useState<ApiError | null>(null)
  const [hostErr, setHostErr] = useState<ApiError | null>(null)
  const [importing, setImporting] = useState(false)
  const [uninstalling, setUninstalling] = useState<{ mid: MidView; jobId: string | null } | null>(null)
  // A job was accepted but the next poll has not reported it yet: the MID counts as busy meanwhile.
  const [optimistic, setOptimistic] = useState<{ name: string; prevJobId: string | null } | null>(null)

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
    if (m.data) {
      setMids(m.data)
      // Confirmed: the poll now reports an active job for that MID.
      // ...or it is gone, or its latest job is no longer the one seen when the request was made (it finished fast / failed).
      setOptimistic((o) => {
        if (!o) return o
        const x = m.data!.find((y) => y.name === o.name)
        return !x || jobIsActive(x) || (x.job?.id ?? null) !== o.prevJobId ? null : o
      })
    }
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

  // The wizard lives in the URL (?create=1&job=<id>) so a reload resumes the progress view.
  const keepMid = selected ? `mid=${encodeURIComponent(selected)}&` : ""
  const openWizard = useCallback(() => router.replace(`${pathname}?${keepMid}create=1`, { scroll: false }), [router, pathname, keepMid])
  const setWizardJob = useCallback((id: string) => router.replace(`${pathname}?${keepMid}create=1&job=${encodeURIComponent(id)}`, { scroll: false }), [router, pathname, keepMid])
  const closeWizard = useCallback(() => {
    void refresh()
    router.replace(selected ? `${pathname}?mid=${encodeURIComponent(selected)}` : pathname, { scroll: false })
  }, [router, pathname, selected, refresh])
  const openCreated = useCallback((name: string) => {
    void refresh()
    router.replace(`${pathname}?mid=${encodeURIComponent(name)}`, { scroll: false })
  }, [router, pathname, refresh])

  useEffect(() => {
    if (!optimistic) return
    const id = setTimeout(() => setOptimistic(null), OPTIMISTIC_MS)
    return () => clearTimeout(id)
  }, [optimistic])

  // The dashboard owns any uninstall job: one that is in flight (or failed) when the page loads or the poll first sees it
  // reopens the dialog in resume mode, unless the user already dismissed it for that job in this tab.
  if (uninstalling === null && mids) {
    const dismissed = dismissedJobs()
    const m = mids.find((x) => resumableUninstall(x) && !dismissed.includes(x.job!.id))
    if (m) setUninstalling({ mid: m, jobId: m.job!.id })
  }

  const startOptimistic = (name: string) => setOptimistic({ name, prevJobId: mids?.find((x) => x.name === name)?.job?.id ?? null })

  const current = mids?.find((m) => m.name === selected) ?? null

  return (
    <AppChrome user={{ email, role: isAdmin ? "admin" : "member" }}>
      <main className="px-4 md:px-8 py-4">
        <DashboardToolbar host={host} mids={mids ?? []} onImport={() => setImporting(true)} onCreate={openWizard} />
        {forbidden && (
          <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p>หน้านั้นสำหรับ Admin เท่านั้น (ต้องเป็น Admin) หากต้องการสิทธิ์ ให้ติดต่อ Admin ของ MidHub</p>
            <button type="button" onClick={() => router.replace(selected ? `${pathname}?mid=${encodeURIComponent(selected)}` : pathname)}
              className="ml-auto shrink-0 text-amber-800 underline">Close</button>
          </div>
        )}
        {midsErr && <div className="mb-4"><ErrorNotice error={midsErr} /></div>}
        {hostErr && <div className="mb-4"><ErrorNotice error={hostErr} /></div>}
        {mids === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : mids.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md rounded-xl border border-gray-200 bg-white dark:bg-neutral-800 p-8 text-center">
            <p className="text-lg font-medium text-gray-900">No MID Servers</p>
            <p className="mt-2 text-sm text-gray-600">ถ้ามี MID ที่ติดตั้งไว้บนเครื่องนี้แล้ว กดปุ่มด้านล่างเพื่อนำเข้ามาจัดการได้เลย</p>
            <button type="button" onClick={() => setImporting(true)}
              className="mt-4 btn-primary px-4 py-2 text-sm font-medium">
              Import MID Server
            </button>
            <button type="button" onClick={openWizard} className="mt-3 block w-full text-sm font-medium text-blue-700 underline">
              New MID Server
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)]">
            <nav aria-label="MID" className="min-w-0 rounded-xl border border-gray-200 bg-white dark:bg-neutral-800 p-2">
              <MidList mids={mids} selected={selected} onSelect={pick} />
            </nav>
            <div ref={panelRef} className="min-w-0 scroll-mt-4 rounded-xl border border-gray-200 bg-white dark:bg-neutral-800 p-4 sm:p-5">
              {current
                ? <MidPanel key={current.name} mid={current} host={host} isAdmin={isAdmin} userId={userId} onChanged={() => void refresh()} onUninstall={(m) => setUninstalling({ mid: m, jobId: null })}
                    jobOwnedElsewhere={uninstalling?.mid.name === current.name} optimisticBusy={optimistic?.name === current.name} />
                : <p className="text-sm text-gray-500">เลือก MID จากรายการเพื่อดูรายละเอียด</p>}
            </div>
          </div>
        )}
      </main>
      {creating && (
        <CreateMidWizard isAdmin={isAdmin} host={host} mids={mids ?? []} jobId={jobParam}
          onJobChange={setWizardJob} onOpenMid={openCreated} onClose={closeWizard}
          userId={userId} onStarted={(name) => { startOptimistic(name); void refresh() }} />
      )}
      {uninstalling && (
        <UninstallDialog mid={uninstalling.mid} jobId={uninstalling.jobId}
          viewer={{ isAdmin, userId }} onStarted={() => { startOptimistic(uninstalling.mid.name); void refresh() }}
          onClose={(id) => { if (id) dismissJob(id); setUninstalling(null); void refresh() }} />
      )}
      {importing && (
        <ImportMidDialog onCancel={() => setImporting(false)}
          onDone={(name) => { setImporting(false); void refresh(); select(name) }} />
      )}
    </AppChrome>
  )
}
