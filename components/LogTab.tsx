"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { API_BASE, apiFetch } from "@/lib/ui/api"
import { LOG_VIEW_LINES, tokenizeLogLine, type LogTokenKind } from "@/lib/ui/log-highlight"
import { levelMatches, nextBackoff, shouldRetry } from "@/lib/ui/log-stream"

const MAX_LINES = LOG_VIEW_LINES
const FILES = [{ id: "main", label: "Agent Log" }, { id: "wrapper", label: "Wrapper Log" }] as const
const LEVELS = [{ id: "", label: "All Levels" }, { id: "ERROR", label: "Errors" }, { id: "WARN+", label: "Warnings and Above" }] as const
type Status = "connecting" | "live" | "missing"
type Line = { id: number; text: string }

const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองเชื่อมต่อใหม่" }
const ctl = "rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-50"
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const KIND_COLOR: Record<LogTokenKind, string> = {
  plain: "", time: "text-[#6a9955]", "level-error": "text-[#f48771] font-semibold", "level-warn": "text-[#cca700] font-semibold",
  "level-info": "text-[#4fc1ff]", "level-debug": "text-[#808080]", thread: "text-[#c586c0]", class: "text-[#4ec9b0]",
  number: "text-[#b5cea8]", string: "text-[#ce9178]", path: "text-[#9cdcfe]",
}
const MARK = "bg-[#623315] text-inherit"

/** Match ranges of `q` over the whole line, so a match may span several coloured tokens. */
function matchRanges(text: string, q: string): [number, number][] {
  if (!q) return []
  const out: [number, number][] = []
  for (const m of text.matchAll(new RegExp(esc(q), "gi"))) out.push([m.index, m.index + m[0].length])
  return out
}

/** `piece` is text[start, start + piece.length): wrap the parts inside a match range in <mark>. */
function marked(piece: string, start: number, ranges: [number, number][]): React.ReactNode {
  if (!ranges.length) return piece
  const end = start + piece.length
  const out: React.ReactNode[] = []
  let pos = start
  for (const [a, b] of ranges) {
    const s = Math.max(a, pos), e = Math.min(b, end)
    if (e <= s) continue
    if (s > pos) out.push(piece.slice(pos - start, s - start))
    out.push(<mark key={s} className={MARK}>{piece.slice(s - start, e - start)}</mark>)
    pos = e
  }
  if (pos < end) out.push(piece.slice(pos - start))
  return out
}

// The line body is memoised by (text, q) only; the row number is rendered outside it so appends don't re-render every body.
const LineBody = memo(function LineBody({ text, q }: { text: string; q: string }) {
  const ranges = matchRanges(text, q)
  const spans: React.ReactNode[] = []
  let start = 0 // running token offset (linear, not a slice+reduce per token)
  for (const [i, t] of tokenizeLogLine(text).entries()) {
    spans.push(<span key={i} data-kind={t.kind} className={KIND_COLOR[t.kind]}>{marked(t.text, start, ranges)}</span>)
    start += t.text.length
  }
  return <span className="whitespace-pre-wrap break-all">{spans.length ? spans : " "}</span>
})

function Row({ n, text, q }: { n: number; text: string; q: string }) {
  return (
    <div data-row className="grid grid-cols-[3.5rem_minmax(0,1fr)] hover:bg-white/5">
      <span data-gutter className="select-none pr-3 text-right text-[#858585]">{n}</span>
      <LineBody text={text} q={q} />
    </div>
  )
}

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

  const statusText = paused ? "Paused" : status === "live" ? "Live" : status === "missing" ? "Log Not Found" : "Connecting…"
  const dot = paused ? "bg-gray-400" : status === "live" ? "bg-green-500" : status === "missing" ? "bg-amber-500" : "bg-blue-400"

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Log File" value={file} onChange={(e) => switchFile(e.target.value as typeof file)} className={ctl}>
          {FILES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <select aria-label="Log Level" value={level} onChange={(e) => setLevel(e.target.value)} className={ctl}>
          {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <input type="search" aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)}
          className="min-w-[10rem] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        <button type="button" onClick={togglePause} aria-pressed={paused} className={ctl}>{paused ? "Follow" : "Pause"}</button>
        {paused && newWhilePaused > 0 && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">{newWhilePaused.toLocaleString()} new lines</span>
        )}
        <a href={`${API_BASE}${url}&download=1`} className={ctl}>Download</a>
        <span role="status" className="flex items-center gap-1.5 text-sm text-gray-600">
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />{statusText}
        </span>
      </div>
      {err && <div className="mt-3"><ErrorNotice error={err} /></div>}
      <div ref={box} tabIndex={0} aria-label="Log Content"
        className="mt-3 h-[max(32rem,calc(100svh-22rem))] overflow-auto rounded-lg border border-neutral-700 bg-[#1e1e1e] py-2 font-mono text-[12.5px] leading-5 text-[#d4d4d4]">
        {shown.length === 0 && <p className="px-3 text-[#858585]">{status === "missing" ? "ไม่พบไฟล์ log (MID อาจยังไม่เคยรัน)" : "ยังไม่มีบรรทัดที่ตรงเงื่อนไข"}</p>}
        {shown.map((l, i) => <Row key={l.id} n={i + 1} text={l.text} q={q} />)}
      </div>
      <p className="mt-1 text-xs text-gray-500">Showing the latest {MAX_LINES} lines</p>
    </div>
  )
}
