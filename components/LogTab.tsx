"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { API_BASE, apiFetch } from "@/lib/ui/api"
import { levelMatches, nextBackoff, shouldRetry } from "@/lib/ui/log-stream"

const MAX_LINES = 5000
const FILES = [{ id: "main", label: "agent (main)" }, { id: "wrapper", label: "wrapper" }] as const
const LEVELS = [{ id: "", label: "ทั้งหมด" }, { id: "ERROR", label: "ERROR" }, { id: "WARN+", label: "WARN ขึ้นไป" }] as const
type Status = "connecting" | "live" | "missing"
type Line = { id: number; text: string }

const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองเชื่อมต่อใหม่" }
const ctl = "rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-50"
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const tone = (t: string) => (levelMatches(t, "ERROR") ? "text-red-700" : levelMatches(t, "WARN") ? "text-amber-700" : "text-gray-800")

const Row = memo(function Row({ text, q }: { text: string; q: string }) {
  let body: React.ReactNode = text
  if (q) {
    const parts = text.split(new RegExp(`(${esc(q)})`, "i"))
    body = parts.map((p, i) => (i % 2 ? <mark key={i} className="bg-yellow-200">{p}</mark> : p))
  }
  return <div className={`whitespace-pre-wrap break-all ${tone(text)}`}>{body || " "}</div>
})

export function LogTab({ midName }: { midName: string }) {
  const [file, setFile] = useState<(typeof FILES)[number]["id"]>("main")
  const [level, setLevel] = useState("")
  const [q, setQ] = useState("")
  const [paused, setPaused] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [status, setStatus] = useState<Status>("connecting")
  const [err, setErr] = useState<ApiError | null>(null)
  const [snapshot, setSnapshot] = useState<Line[]>([]) // the list as it was when paused
  const [pausedAt, setPausedAt] = useState(0) // id of the next line at pause time
  const nextId = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const url = `/mids/${encodeURIComponent(midName)}/logs?file=${file}`

  useEffect(() => {
    const ac = new AbortController()
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // The server replays its window on every connect: keep the old lines until the first new batch, then replace them.
    let replace = true

    function onFrame(frame: string) {
      let ev = "message"
      let data = ""
      for (const l of frame.split("\n")) {
        if (l.startsWith("event:")) ev = l.slice(6).trim()
        else if (l.startsWith("data:")) data += l.slice(5).trim()
      }
      if (!data || ac.signal.aborted) return // comment / ping, or a late frame from a connection we already closed
      try {
        const j = JSON.parse(data) as { lines?: string[]; state?: Status; message?: string }
        if (ev === "status" && j.state) { attempt = 0; setStatus(j.state) }
        else if (ev === "error") setErr({ message: j.message ?? "อ่าน log ไม่สำเร็จ" })
        else if (j.lines) {
          attempt = 0
          const add = j.lines.map((text) => ({ id: nextId.current++, text }))
          const fresh = replace
          replace = false
          setStatus("live")
          setLines((prev) => { const n = fresh ? add : prev.concat(add); return n.length > MAX_LINES ? n.slice(n.length - MAX_LINES) : n })
        }
      } catch { /* malformed frame: skip */ }
    }

    async function connect() {
      if (ac.signal.aborted) return
      replace = true
      let retry = true
      try {
        const res = await apiFetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } })
        if (!res.ok || !res.body) {
          const e = await readApiError(res)
          setErr(e)
          retry = shouldRetry(res.status)
        } else {
          setErr(null)
          const rd = res.body.pipeThrough(new TextDecoderStream()).getReader()
          let buf = ""
          for (;;) {
            const { done, value } = await rd.read()
            if (done) break
            buf += value
            let i: number
            while ((i = buf.indexOf("\n\n")) >= 0) { onFrame(buf.slice(0, i)); buf = buf.slice(i + 2) }
          }
        }
      } catch {
        if (ac.signal.aborted) return
        setErr(NETWORK)
      }
      if (retry && !ac.signal.aborted) {
        setStatus("connecting")
        timer = setTimeout(() => void connect(), nextBackoff(attempt++))
      }
    }
    void connect()
    return () => { ac.abort(); clearTimeout(timer) }
  }, [url])

  const shown = useMemo(() => {
    const needle = q.toLowerCase()
    return (paused ? snapshot : lines).filter((l) => levelMatches(l.text, level) && (!needle || l.text.toLowerCase().includes(needle)))
  }, [lines, snapshot, level, q, paused])

  useEffect(() => {
    if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown, paused])

  function togglePause() {
    if (!paused) { setSnapshot(lines); setPausedAt(nextId.current) }
    setPaused((p) => !p)
  }
  // Lines that arrived while paused (approximate after a reconnect, which replays the server window).
  const newWhilePaused = paused ? Math.max(0, (lines.at(-1)?.id ?? pausedAt - 1) + 1 - pausedAt) : 0
  function switchFile(f: (typeof FILES)[number]["id"]) {
    setFile(f); setLines([]); setErr(null)
  }

  const statusText = paused ? "หยุดชั่วคราว" : status === "live" ? "สด" : status === "missing" ? "ไม่พบไฟล์ log" : "กำลังเชื่อมต่อ"
  const dot = paused ? "bg-gray-400" : status === "live" ? "bg-green-500" : status === "missing" ? "bg-amber-500" : "bg-blue-400"

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="ไฟล์ log" value={file} onChange={(e) => switchFile(e.target.value as typeof file)} className={ctl}>
          {FILES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <select aria-label="ระดับ log" value={level} onChange={(e) => setLevel(e.target.value)} className={ctl}>
          {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <input type="search" aria-label="ค้นหาใน log" placeholder="ค้นหา" value={q} onChange={(e) => setQ(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        <button type="button" onClick={togglePause} aria-pressed={paused} className={ctl}>{paused ? "เลื่อนอัตโนมัติ" : "หยุดชั่วคราว"}</button>
        {paused && newWhilePaused > 0 && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">มีบรรทัดใหม่ {newWhilePaused.toLocaleString()} บรรทัด</span>
        )}
        <a href={`${API_BASE}${url}&download=1`} className={ctl}>ดาวน์โหลด</a>
        <span role="status" className="flex items-center gap-1.5 text-sm text-gray-600">
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />{statusText}
        </span>
      </div>
      {err && <div className="mt-3"><ErrorNotice error={err} /></div>}
      <div ref={box} tabIndex={0} aria-label="เนื้อหา log" className="mt-3 h-[28rem] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-2 font-mono text-xs">
        {shown.length === 0 && <p className="p-2 text-gray-500">{status === "missing" ? "ไม่พบไฟล์ log (MID อาจยังไม่เคยรัน)" : "ยังไม่มีบรรทัดที่ตรงเงื่อนไข"}</p>}
        {shown.map((l) => <Row key={l.id} text={l.text} q={q} />)}
      </div>
      <p className="mt-1 text-xs text-gray-500">แสดงล่าสุดสูงสุด {MAX_LINES.toLocaleString()} บรรทัด ({shown.length.toLocaleString()} ที่แสดง)</p>
    </div>
  )
}
