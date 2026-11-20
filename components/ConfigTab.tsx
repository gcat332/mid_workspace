"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { MAX_HEAP_MB, MIN_HEAP_MB } from "@/lib/helper/protocol"
import { inputCls } from "@/lib/ui/classes"
import { useIsDark } from "@/lib/ui/use-is-dark"

const EDITOR_LOADING = <p className="p-3 text-sm text-gray-500">Loading…</p>
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false, loading: () => EDITOR_LOADING })
const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), { ssr: false, loading: () => EDITOR_LOADING })

type ConfigFile = "config.xml" | "wrapper-override.conf"
type FileState = { content: string; hash: string }
type Form = {
  url: string; username: string; midName: string; useProxy: boolean
  proxyHost: string; proxyPort: string; proxyUser: string; heapMb: number
  /** Set on disk (values never reach the browser). */
  hasPassword?: boolean; hasProxyPassword?: boolean
}
type Data = { files: Record<ConfigFile, FileState>; form: Form; warning?: string }
type Backup = { id: string; file: ConfigFile; note: string; createdBy: string; createdAt: string }
type BackupFull = Backup & { content: string }

const LANG: Record<ConfigFile, string> = { "config.xml": "xml", "wrapper-override.conf": "ini" }
const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const input = `mt-1 ${inputCls} disabled:bg-gray-50 dark:disabled:bg-neutral-800`
const fieldCls = "text-xs font-medium text-gray-600 dark:text-neutral-300"
/** One section of the form: a titled group laid out in two columns from lg. */
const sectionCls = "grid gap-x-4 gap-y-3 lg:grid-cols-2"
const legendCls = "mb-2 text-sm font-semibold text-gray-900 dark:text-neutral-100"
const btn = "rounded-lg border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH")
const KEEP_PW = "•••••••• (ตั้งไว้แล้ว — เว้นว่าง = ไม่เปลี่ยน)"

type Props = {
  midName: string
  /** Non-null while a lifecycle job is running: every write is disabled and this text is shown as the reason. */
  busyReason?: string | null
  /** Offer "Restart เลยไหม?" after a save (only meaningful while the MID is up). */
  canRestart: boolean
  /** Restart request owned by MidPanel (handles the low-memory confirmation). */
  onRestart: () => void
}

export function ConfigTab({ midName, busyReason = null, canRestart, onRestart }: Props) {
  const dark = useIsDark()
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
  const [saved, setSaved] = useState(false)

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

  const load = useCallback(async (keepError = false) => {
    try {
      const res = await apiFetch(base)
      if (!res.ok) { setErr(await readApiError(res)); return }
      if (!keepError) setErr(null)
      apply((await res.json()) as Data)
      await loadBackups()
    } catch { setErr(NETWORK) }
  }, [base, apply, loadBackups])

  // Initial fetch: every setState inside load() happens after an await.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  async function send(path: string, init: RequestInit, after: () => void) {
    if (busyReason) { setErr({ message: busyReason }); return }
    setBusy(true); setErr(null); setSaved(false)
    try {
      const res = await apiFetch(path, init)
      if (!res.ok) { setErr(await readApiError(res)); if (res.status === 502) void load(true); return }
      apply((await res.json()) as Data)
      await loadBackups()
      setSaved(true)
      after()
    } catch { setErr(NETWORK) } finally { setBusy(false) }
  }
  const put = (body: object) => send(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, () => canRestart && setAskRestart(true))

  if (!data || !form) return err ? <ErrorNotice error={err} /> : <p className="text-sm text-gray-500">Loading…</p>

  const setF = <K extends keyof Form>(k: K, v: Form[K]) => { setSaved(false); setForm({ ...form, [k]: v }) }
  const heapOk = Number.isInteger(form.heapMb) && form.heapMb >= MIN_HEAP_MB && form.heapMb <= MAX_HEAP_MB
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
      <div role="group" aria-label="Edit Mode" className="inline-flex overflow-hidden rounded-lg border border-gray-300 text-sm">
        {(["form", "raw"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
            className={`px-4 py-1.5 ${mode === m ? "bg-blue-600 text-white" : "bg-white dark:bg-neutral-800 text-gray-700 hover:bg-gray-50"}`}>
            {m === "form" ? "Form" : "Raw"}
          </button>
        ))}
      </div>

      {busyReason && <p role="status" className="text-sm text-amber-700">{busyReason} — แก้ไขและบันทึกไม่ได้จนกว่างานจะเสร็จ</p>}
      {saved && !err && <p role="status" className="text-sm text-emerald-700">Saved</p>}
      {data.warning && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{data.warning}</p>}
      {err && (
        <div className="space-y-2">
          <ErrorNotice error={err} />
          {stale && <button type="button" onClick={() => void load()} className={`${btn} border-gray-300 text-gray-800 hover:bg-gray-50`} title="การแก้ไขที่ยังไม่บันทึกจะหาย">Refresh</button>}
        </div>
      )}

      {mode === "form" ? (
        <form className="max-w-4xl space-y-5" onSubmit={(e) => {
          e.preventDefault()
          void put({ baseHash: data.files["config.xml"].hash, wrapperBaseHash: data.files["wrapper-override.conf"].hash, form: { ...form, password: pw.password, proxyPassword: pw.proxyPassword } })
        }}>
          <fieldset className={sectionCls}>
            <legend className={legendCls}>Instance</legend>
            <label className={`${fieldCls} lg:col-span-2`}>Instance URL
              <input className={input} value={form.url} onChange={(e) => setF("url", e.target.value)} /></label>
            <label className={fieldCls}>Username
              <input className={input} value={form.username} onChange={(e) => setF("username", e.target.value)} autoComplete="off" /></label>
            <label className={fieldCls}>Password <span className="font-normal text-gray-500">(เว้นว่าง = ไม่เปลี่ยน)</span>
              <input className={input} type="password" value={pw.password} onChange={(e) => { setSaved(false); setPw({ ...pw, password: e.target.value }) }} autoComplete="new-password"
                placeholder={form.hasPassword ? KEEP_PW : "Not Set"} /></label>
          </fieldset>

          <fieldset className={sectionCls}>
            <legend className={legendCls}>MID Server</legend>
            <label className={fieldCls}>MID Server Name
              <input className={input} value={form.midName} onChange={(e) => setF("midName", e.target.value)} /></label>
            <div>
              <label className={`${fieldCls} block`}>Heap (MB)
                <input className={input} type="number" min={MIN_HEAP_MB} max={MAX_HEAP_MB} step={64} value={Number.isNaN(form.heapMb) ? "" : form.heapMb}
                  onChange={(e) => setF("heapMb", e.target.valueAsNumber)} aria-invalid={!heapOk} aria-describedby="heap-range" /></label>
              <p id="heap-range" className="mt-1 text-xs text-gray-500">{MIN_HEAP_MB}–{MAX_HEAP_MB} MB</p>
            </div>
            {!heapOk && <p className="text-xs text-red-700 lg:col-span-2">RAM ต้องเป็นจำนวนเต็ม {MIN_HEAP_MB}-{MAX_HEAP_MB} MB</p>}
          </fieldset>

          <fieldset className={sectionCls}>
            <legend className={legendCls}>Proxy</legend>
            <label className="flex items-center gap-2 text-sm text-gray-700 lg:col-span-2">
              <input type="checkbox" checked={form.useProxy} onChange={(e) => setF("useProxy", e.target.checked)} /> Use Proxy</label>
            {form.useProxy && (
              <>
                <label className={fieldCls}>Proxy Host
                  <input className={input} value={form.proxyHost} onChange={(e) => setF("proxyHost", e.target.value)} /></label>
                <label className={fieldCls}>Proxy Port
                  <input className={input} inputMode="numeric" value={form.proxyPort} onChange={(e) => setF("proxyPort", e.target.value)} /></label>
                <label className={fieldCls}>Proxy Username
                  <input className={input} value={form.proxyUser} onChange={(e) => setF("proxyUser", e.target.value)} autoComplete="off" /></label>
                <label className={fieldCls}>Proxy Password <span className="font-normal text-gray-500">(เว้นว่าง = ไม่เปลี่ยน)</span>
                  <input className={input} type="password" value={pw.proxyPassword} onChange={(e) => { setSaved(false); setPw({ ...pw, proxyPassword: e.target.value }) }} autoComplete="new-password"
                    placeholder={form.hasProxyPassword ? KEEP_PW : "Not Set"} /></label>
              </>
            )}
          </fieldset>

          <div className="flex justify-end gap-2 border-t border-gray-200 pt-4"><button type="submit" disabled={busy || !heapOk || !!busyReason} className={`btn-primary px-4 py-2 text-sm`}>
            {busy ? "Saving…" : "Save"}</button></div>
        </form>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <select aria-label="File" value={rawFile} onChange={(e) => setRawFile(e.target.value as ConfigFile)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="config.xml">config.xml</option>
              <option value="wrapper-override.conf">wrapper-override.conf</option>
            </select>
            <button type="button" disabled={busy || !!busyReason}
              onClick={() => void put({ file: rawFile, content: drafts[rawFile], baseHash: data.files[rawFile].hash })}
              className={`btn-primary px-4 py-2 text-sm`}>{busy ? "Saving…" : "Save"}</button>
          </div>
          {rawFile === "config.xml" && <p className="text-xs text-gray-500">ค่า password แสดงเป็น ******** — ถ้าไม่แก้ ระบบจะคงค่าเดิมในไฟล์ไว้</p>}
          <div className="h-96 overflow-hidden rounded-lg border border-gray-300">
            <MonacoEditor theme={dark ? "vs-dark" : "vs"} height="100%" language={LANG[rawFile]} path={`${midName}/${rawFile}`} value={drafts[rawFile]}
              loading={EDITOR_LOADING}
              onChange={(v) => { setSaved(false); setDrafts((d) => ({ ...d, [rawFile]: v ?? "" })) }} options={{ minimap: { enabled: false }, scrollBeyondLastLine: false }} />
          </div>
        </div>
      )}

      <section aria-label="Backup History" className="border-t border-gray-200 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Backup History</h3>
        </div>
        {backups.length === 0 ? <p className="mt-1 text-sm text-gray-500">No Backups</p> : (
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {backups.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 rounded px-1 py-1.5 hover:bg-gray-50">
                <span className="font-mono text-xs">{b.file}</span>
                <span className="text-xs text-gray-600"><span className="font-mono">{fmt(b.createdAt)}</span> · {b.createdBy}{b.note ? ` · ${b.note}` : ""}</span>
                <button type="button" onClick={() => void pickBackup(b.id)} aria-pressed={selected?.id === b.id}
                  className="ml-auto text-blue-600 dark:text-blue-400 hover:underline">Compare</button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-500">ซ้าย = backup, ขวา = ไฟล์ปัจจุบัน (password ถูกปิดบัง)</p>
            <div className="h-80 overflow-hidden rounded-lg border border-gray-300">
              {/* Keep the models alive across unmount (rollback clears `selected`): disposing them first makes Monaco
                  log "TextModel got disposed before DiffEditorWidget model got reset". Paths are keyed by immutable
                  content (backup id, current hash) because an existing model is reused as-is on the next mount. */}
              <DiffEditor theme={dark ? "vs-dark" : "vs"} height="100%" language={LANG[selected.file]} original={selected.content}
                modified={data.files[selected.file].content} loading={EDITOR_LOADING}
                originalModelPath={`diff/${midName}/backup/${selected.id}`}
                modifiedModelPath={`diff/${midName}/current/${data.files[selected.file].hash}/${selected.file}`}
                keepCurrentOriginalModel keepCurrentModifiedModel
                options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }} />
            </div>
            <button type="button" disabled={busy || !!busyReason} onClick={() => setConfirmRollback(true)}
              className={`${btn} border-red-300 text-red-700 hover:bg-red-50`}>Roll Back</button>
          </div>
        )}
      </section>

      {confirmRollback && selected && (
        <ConfirmDialog title="Roll Back File?" danger busy={busy} confirmLabel="Roll Back"
          onCancel={() => setConfirmRollback(false)}
          onConfirm={() => void send(`${base}/backups/${encodeURIComponent(selected.id)}`, { method: "POST" }, () => canRestart && setAskRestart(true)).then(() => setConfirmRollback(false))}>
          ไฟล์ {selected.file} จะถูกแทนที่ด้วยเวอร์ชัน backup นี้ (เวอร์ชันปัจจุบันจะถูกเก็บเป็น backup ก่อน)
        </ConfirmDialog>
      )}
      {askRestart && (
        <ConfirmDialog title="Restart Now?" confirmLabel="Restart" onCancel={() => setAskRestart(false)}
          onConfirm={() => { setAskRestart(false); onRestart() }}>
          บันทึกแล้ว การตั้งค่าใหม่จะมีผลหลัง restart MID (งานที่กำลังทำอยู่จะถูกขัดจังหวะ)
        </ConfirmDialog>
      )}
    </div>
  )
}
