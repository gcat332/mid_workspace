"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false })
const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), { ssr: false })

type ConfigFile = "config.xml" | "wrapper-override.conf"
type FileState = { content: string; hash: string }
type Form = {
  url: string; username: string; midName: string; useProxy: boolean
  proxyHost: string; proxyPort: string; proxyUser: string; heapMb: number
}
type Data = { files: Record<ConfigFile, FileState>; form: Form }
type Backup = { id: string; file: ConfigFile; note: string; createdBy: string; createdAt: string }
type BackupFull = Backup & { content: string }

const LANG: Record<ConfigFile, string> = { "config.xml": "xml", "wrapper-override.conf": "ini" }
const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const input = "mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
const btn = "rounded-lg border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH")

type Props = {
  midName: string
  /** Offer "Restart เลยไหม?" after a save (only meaningful while the MID is up). */
  canRestart: boolean
  /** Restart request owned by MidPanel (handles the low-memory confirmation). */
  onRestart: () => void
}

export function ConfigTab({ midName, canRestart, onRestart }: Props) {
  const base = `/mids/${encodeURIComponent(midName)}/config`
  const [data, setData] = useState<Data | null>(null)
  const [mode, setMode] = useState<"form" | "raw">("form")
  const [rawFile, setRawFile] = useState<ConfigFile>("config.xml")
  const [drafts, setDrafts] = useState<Record<ConfigFile, string>>({ "config.xml": "", "wrapper-override.conf": "" })
  const [form, setForm] = useState<Form | null>(null)
  const [pw, setPw] = useState({ password: "", proxyPassword: "" })
  const [err, setErr] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [askRestart, setAskRestart] = useState(false)
  const [backups, setBackups] = useState<Backup[]>([])
  const [selected, setSelected] = useState<BackupFull | null>(null)
  const [confirmRollback, setConfirmRollback] = useState(false)

  const apply = useCallback((d: Data) => {
    setData(d)
    setForm(d.form)
    setPw({ password: "", proxyPassword: "" })
    setDrafts({ "config.xml": d.files["config.xml"].content, "wrapper-override.conf": d.files["wrapper-override.conf"].content })
    setSelected(null)
  }, [])

  const loadBackups = useCallback(async () => {
    try {
      const res = await apiFetch(`${base}/backups`)
      if (res.ok) setBackups(((await res.json()) as { backups: Backup[] }).backups)
    } catch { /* history is secondary; the load error path already tells the user */ }
  }, [base])

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(base)
      if (!res.ok) { setErr(await readApiError(res)); return }
      setErr(null)
      apply((await res.json()) as Data)
      await loadBackups()
    } catch { setErr(NETWORK) }
  }, [base, apply, loadBackups])

  // Initial fetch: every setState inside load() happens after an await.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  async function send(path: string, init: RequestInit, after: () => void) {
    setBusy(true); setErr(null)
    try {
      const res = await apiFetch(path, init)
      if (!res.ok) { setErr(await readApiError(res)); if (res.status === 502) void load(); return }
      apply((await res.json()) as Data)
      await loadBackups()
      after()
    } catch { setErr(NETWORK) } finally { setBusy(false) }
  }
  const put = (body: object) => send(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, () => canRestart && setAskRestart(true))

  if (!data || !form) return err ? <ErrorNotice error={err} /> : <p className="text-sm text-gray-500">กำลังโหลดการตั้งค่า...</p>

  const setF = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v })
  const heapOk = Number.isInteger(form.heapMb) && form.heapMb >= 256 && form.heapMb <= 8192
  const stale = err?.code === "stale"

  async function pickBackup(id: string) {
    setErr(null)
    try {
      const res = await apiFetch(`${base}/backups/${encodeURIComponent(id)}`)
      if (res.ok) setSelected((await res.json()) as BackupFull)
      else setErr(await readApiError(res))
    } catch { setErr(NETWORK) }
  }

  return (
    <div className="space-y-4">
      <div role="group" aria-label="โหมดแก้ไข" className="inline-flex overflow-hidden rounded-lg border border-gray-300 text-sm">
        {(["form", "raw"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
            className={`px-4 py-1.5 ${mode === m ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}>
            {m === "form" ? "ฟอร์ม" : "Raw"}
          </button>
        ))}
      </div>

      {err && (
        <div className="space-y-2">
          <ErrorNotice error={err} />
          {stale && <button type="button" onClick={() => void load()} className={`${btn} border-gray-300 text-gray-800 hover:bg-gray-50`}>โหลดใหม่</button>}
        </div>
      )}

      {mode === "form" ? (
        <form className="grid max-w-2xl gap-3" onSubmit={(e) => {
          e.preventDefault()
          void put({ baseHash: data.files["config.xml"].hash, form: { ...form, password: pw.password, proxyPassword: pw.proxyPassword } })
        }}>
          <label className="text-sm text-gray-700">Instance URL
            <input className={input} value={form.url} onChange={(e) => setF("url", e.target.value)} /></label>
          <label className="text-sm text-gray-700">Username
            <input className={input} value={form.username} onChange={(e) => setF("username", e.target.value)} autoComplete="off" /></label>
          <label className="text-sm text-gray-700">Password (เว้นว่าง = ไม่เปลี่ยน)
            <input className={input} type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" /></label>
          <label className="text-sm text-gray-700">ชื่อ MID ใน ServiceNow
            <input className={input} value={form.midName} onChange={(e) => setF("midName", e.target.value)} /></label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.useProxy} onChange={(e) => setF("useProxy", e.target.checked)} /> ใช้ Proxy</label>
          {form.useProxy && (
            <div className="grid gap-3 rounded-lg border border-gray-200 p-3">
              <label className="text-sm text-gray-700">Proxy host
                <input className={input} value={form.proxyHost} onChange={(e) => setF("proxyHost", e.target.value)} /></label>
              <label className="text-sm text-gray-700">Proxy port
                <input className={input} inputMode="numeric" value={form.proxyPort} onChange={(e) => setF("proxyPort", e.target.value)} /></label>
              <label className="text-sm text-gray-700">Proxy username
                <input className={input} value={form.proxyUser} onChange={(e) => setF("proxyUser", e.target.value)} autoComplete="off" /></label>
              <label className="text-sm text-gray-700">Proxy password (เว้นว่าง = ไม่เปลี่ยน)
                <input className={input} type="password" value={pw.proxyPassword} onChange={(e) => setPw({ ...pw, proxyPassword: e.target.value })} autoComplete="new-password" /></label>
            </div>
          )}
          <label className="text-sm text-gray-700">RAM (heap) MB — 256 ถึง 8192
            <input className={input} type="number" min={256} max={8192} step={64} value={Number.isNaN(form.heapMb) ? "" : form.heapMb}
              onChange={(e) => setF("heapMb", e.target.valueAsNumber)} aria-invalid={!heapOk} /></label>
          {!heapOk && <p className="text-xs text-red-700">RAM ต้องเป็นจำนวนเต็ม 256-8192 MB</p>}
          <div><button type="submit" disabled={busy || !heapOk} className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>
            {busy ? "กำลังบันทึก..." : "บันทึก"}</button></div>
        </form>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="ไฟล์" value={rawFile} onChange={(e) => setRawFile(e.target.value as ConfigFile)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="config.xml">config.xml</option>
              <option value="wrapper-override.conf">wrapper-override.conf</option>
            </select>
            <button type="button" disabled={busy}
              onClick={() => void put({ file: rawFile, content: drafts[rawFile], baseHash: data.files[rawFile].hash })}
              className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>{busy ? "กำลังบันทึก..." : "บันทึก"}</button>
          </div>
          {rawFile === "config.xml" && <p className="text-xs text-gray-500">ค่า password แสดงเป็น ******** — ถ้าไม่แก้ ระบบจะคงค่าเดิมในไฟล์ไว้</p>}
          <div className="h-96 overflow-hidden rounded-lg border border-gray-300">
            <MonacoEditor height="100%" language={LANG[rawFile]} path={`${midName}/${rawFile}`} value={drafts[rawFile]}
              onChange={(v) => setDrafts((d) => ({ ...d, [rawFile]: v ?? "" }))} options={{ minimap: { enabled: false }, scrollBeyondLastLine: false }} />
          </div>
        </div>
      )}

      <section aria-label="ประวัติการแก้ไข" className="border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold text-gray-900">ประวัติการแก้ไข (backup)</h3>
        {backups.length === 0 ? <p className="mt-1 text-sm text-gray-500">ยังไม่มี backup</p> : (
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {backups.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="font-mono text-xs">{b.file}</span>
                <span className="text-gray-600">{fmt(b.createdAt)} · {b.createdBy}{b.note ? ` · ${b.note}` : ""}</span>
                <button type="button" onClick={() => void pickBackup(b.id)} aria-pressed={selected?.id === b.id}
                  className="ml-auto text-blue-600 hover:underline">เทียบกับปัจจุบัน</button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-500">ซ้าย = backup, ขวา = ไฟล์ปัจจุบัน (password ถูกปิดบัง)</p>
            <div className="h-80 overflow-hidden rounded-lg border border-gray-300">
              <DiffEditor height="100%" language={LANG[selected.file]} original={selected.content}
                modified={data.files[selected.file].content} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }} />
            </div>
            <button type="button" disabled={busy} onClick={() => setConfirmRollback(true)}
              className={`${btn} border-red-300 text-red-700 hover:bg-red-50`}>Rollback เป็นเวอร์ชันนี้</button>
          </div>
        )}
      </section>

      {confirmRollback && selected && (
        <ConfirmDialog title="Rollback ไฟล์นี้?" danger busy={busy} confirmLabel="Rollback"
          onCancel={() => setConfirmRollback(false)}
          onConfirm={() => void send(`${base}/backups/${encodeURIComponent(selected.id)}`, { method: "POST" }, () => canRestart && setAskRestart(true)).then(() => setConfirmRollback(false))}>
          ไฟล์ {selected.file} จะถูกแทนที่ด้วยเวอร์ชัน backup นี้ (เวอร์ชันปัจจุบันจะถูกเก็บเป็น backup ก่อน)
        </ConfirmDialog>
      )}
      {askRestart && (
        <ConfirmDialog title="Restart เลยไหม?" confirmLabel="Restart" onCancel={() => setAskRestart(false)}
          onConfirm={() => { setAskRestart(false); onRestart() }}>
          บันทึกแล้ว การตั้งค่าใหม่จะมีผลหลัง restart MID (งานที่กำลังทำอยู่จะถูกขัดจังหวะ)
        </ConfirmDialog>
      )}
    </div>
  )
}
