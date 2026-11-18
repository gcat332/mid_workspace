"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useRef, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { Modal } from "./Modal"
import { API_BASE, apiFetch } from "@/lib/ui/api"

const EDITOR_LOADING = <p className="p-3 text-sm text-gray-500">กำลังโหลด editor…</p>
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false, loading: () => EDITOR_LOADING })

type Entry = { name: string; type: "file" | "dir"; size: number; mtime: string; readOnly: boolean; symlink: boolean; locked: boolean; secret: boolean; config: boolean }
type Open = { path: string; content: string; hash: string; draft: string; readOnly: boolean }

const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const MAX_UPLOAD = 50 * 1024 * 1024
const btn = "rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
const join = (a: string, b: string) => (a ? `${a}/${b}` : b)
const EXTLIB = "agent/extlib"
const BAD_NAME: ApiError = { code: "invalid_filename", message: "ชื่อไฟล์/โฟลเดอร์ใช้ / \\ . .. หรือว่างไม่ได้ (ยาวไม่เกิน 255 ไบต์) แก้ชื่อแล้วลองใหม่" }
/** Same rule as the server (lib/mids/files.ts plainName), checked before sending. */
const validName = (n: string) => n !== "" && n !== "." && n !== ".." && !/[\\/\0]/.test(n) && new TextEncoder().encode(n).length <= 255
const LANGS: Record<string, string> = { xml: "xml", json: "json", conf: "ini", properties: "ini", sh: "shell", js: "javascript", yaml: "yaml", yml: "yaml", md: "markdown", log: "plaintext" }
const lang = (n: string) => LANGS[n.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"
function size(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

type Props = { midName: string; /** Switch the MID panel to the config tab (config.xml / wrapper-override.conf rows). */ onOpenConfig: () => void }

export function FilesTab({ midName, onOpenConfig }: Props) {
  const base = `/mids/${encodeURIComponent(midName)}/files`
  const [dir, setDir] = useState("")
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [dirRo, setDirRo] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)
  const [modalErr, setModalErr] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const [newFolder, setNewFolder] = useState(false)
  const [overwrite, setOverwrite] = useState<File | null>(null)
  const [nameDraft, setNameDraft] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async (d: string) => {
    try {
      const res = await apiFetch(`${base}?path=${encodeURIComponent(d)}`)
      if (!res.ok) { setErr(await readApiError(res)); return }
      setErr(null)
      const j = (await res.json()) as { entries: Entry[]; readOnly?: boolean }
      setEntries(j.entries)
      setDirRo(j.readOnly === true)
    } catch { setErr(NETWORK) }
  }, [base])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(dir) }, [load, dir])

  /** `onErr` decides where a failure is shown (the open modal, or the page) so it never appears twice. */
  async function run(fn: () => Promise<Response>, onErr: (e: ApiError) => void = setErr): Promise<boolean> {
    setBusy(true); setErr(null); setModalErr(null)
    try {
      const res = await fn()
      if (!res.ok) { onErr(await readApiError(res)); return false }
      await load(dir)
      return true
    } catch { onErr(NETWORK); return false } finally { setBusy(false) }
  }
  const json = (method: string, body: object) => () =>
    apiFetch(base, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  async function openFile(e: Entry) {
    setErr(null)
    try {
      const res = await apiFetch(`${base}?path=${encodeURIComponent(join(dir, e.name))}&content=1`)
      if (!res.ok) { setErr(await readApiError(res)); return }
      const j = (await res.json()) as { content: string; hash: string }
      setOpen({ path: join(dir, e.name), content: j.content, hash: j.hash, draft: j.content, readOnly: e.readOnly })
    } catch { setErr(NETWORK) }
  }

  async function save() {
    if (!open) return
    setBusy(true); setErr(null); setSaved(false)
    try {
      const res = await apiFetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: open.path, content: open.draft, baseHash: open.hash }) })
      if (!res.ok) { setErr(await readApiError(res)); return }
      const j = (await res.json()) as { hash: string }
      setOpen({ ...open, content: open.draft, hash: j.hash })
      setSaved(true)
      await load(dir)
    } catch { setErr(NETWORK) } finally { setBusy(false) }
  }

  async function reloadOpen() {
    if (!open) return
    const name = open.path.split("/").pop() ?? ""
    setOpen(null)
    await openFile({ name, type: "file", size: 0, mtime: "", readOnly: open.readOnly, symlink: false, locked: false, secret: false, config: false })
  }

  function onPick(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = ""
    if (!f) return
    if (f.size > MAX_UPLOAD) { setErr({ code: "too_large", message: "ไฟล์ใหญ่เกินกำหนด (สูงสุด 50 MB) ลดขนาดไฟล์แล้วลองใหม่" }); return }
    if (entries?.some((x) => x.name === f.name && x.type === "file")) { setOverwrite(f); return }
    sendUpload(f)
  }
  function sendUpload(f: File) {
    const fd = new FormData()
    fd.set("dir", dir)
    fd.set("file", f)
    void run(() => apiFetch(base, { method: "POST", body: fd }))
  }

  const closeEditor = () => { setOpen(null); setErr(null); setSaved(false); setConfirmClose(false) }
  const crumbs = dir ? dir.split("/") : []
  const stale = err?.code === "stale"

  if (open) {
    const dirty = open.draft !== open.content
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${btn} border-gray-300`} onClick={() => (dirty ? setConfirmClose(true) : closeEditor())}>← กลับ</button>
          <span className="break-all font-mono text-sm text-gray-800">{open.path}</span>
          {saved && !dirty && <span role="status" className="text-sm text-emerald-700">บันทึกแล้ว</span>}
          {open.readOnly
            ? <span className="ml-auto text-xs text-gray-500">🔒 อ่านอย่างเดียว</span>
            : <button type="button" disabled={busy || !dirty} onClick={() => void save()}
                className={`${btn} ml-auto border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>{busy ? "กำลังบันทึก..." : "บันทึก"}</button>}
        </div>
        {err && (
          <div className="space-y-2">
            <ErrorNotice error={err} />
            {stale && <button type="button" className={`${btn} border-gray-300`} onClick={() => void reloadOpen()}>โหลดไฟล์ใหม่ (การแก้ไขที่ยังไม่บันทึกจะหาย)</button>}
          </div>
        )}
        <div className="h-96 overflow-hidden rounded-lg border border-gray-300">
          <MonacoEditor height="100%" language={lang(open.path)} path={`${midName}/${open.path}`} value={open.draft} loading={EDITOR_LOADING}
            onChange={(v) => { setSaved(false); setOpen((o) => (o ? { ...o, draft: v ?? "" } : o)) }} options={{ minimap: { enabled: false }, scrollBeyondLastLine: false, readOnly: open.readOnly }} />
        </div>
        {confirmClose && (
          <ConfirmDialog title="ปิดโดยไม่บันทึก?" danger confirmLabel="ปิด ไม่บันทึก" onCancel={() => setConfirmClose(false)} onConfirm={closeEditor}>
            มีการแก้ไขที่ยังไม่บันทึก ถ้าปิดตอนนี้ การแก้ไขจะหาย
          </ConfirmDialog>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="ตำแหน่งโฟลเดอร์" className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setDir("")}>{midName}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-gray-400">/</span>
              <button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" hidden aria-label="เลือกไฟล์อัปโหลด" onChange={(e) => onPick(e.target.files?.[0])} />
          <button type="button" disabled={busy || dirRo} aria-describedby={dirRo ? "ro-hint" : undefined} onClick={() => fileInput.current?.click()} className={`${btn} border-gray-300 text-gray-800 hover:bg-gray-50`}>อัปโหลดไฟล์</button>
          <span className="text-xs text-gray-500">สูงสุด 50 MB ต่อไฟล์</span>
          <button type="button" disabled={busy || dirRo} aria-describedby={dirRo ? "ro-hint" : undefined} onClick={() => { setNameDraft(""); setModalErr(null); setNewFolder(true) }} className={`${btn} border-gray-300 text-gray-800 hover:bg-gray-50`}>โฟลเดอร์ใหม่</button>
        </div>
      </div>
      {dirRo && (
        <p id="ro-hint" className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
          🔒 โฟลเดอร์โปรแกรมของ MID แก้ไขไม่ได้ — อัปโหลด library ที่{" "}
          <button type="button" className="font-mono text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setDir(EXTLIB)}>{EXTLIB}</button> แทน
        </p>
      )}

      {err && !newFolder && !renaming && <ErrorNotice error={err} />}

      {entries === null ? (
        !err && <p className="text-sm text-gray-500">กำลังโหลด...</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr><th className="py-1 pr-2">ชื่อ</th><th className="px-2">ขนาด</th><th className="px-2">แก้ไขล่าสุด</th><th className="pl-2 text-right">จัดการ</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {dir && (
              <tr><td colSpan={4} className="py-1.5"><button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}>📁 ..</button></td></tr>
            )}
            {entries.length === 0 && <tr><td colSpan={4} className="py-3 text-gray-500">โฟลเดอร์ว่าง</td></tr>}
            {entries.map((e) => (
              <tr key={e.name}>
                <td className="py-1.5 pr-2">
                  <span aria-hidden>{e.type === "dir" ? "📁" : "📄"} </span>
                  {e.type === "dir"
                    ? <button type="button" className="text-blue-700 hover:underline" onClick={() => setDir(join(dir, e.name))}>{e.name}</button>
                    : <span className="break-all">{e.name}</span>}
                  {e.readOnly && <span role="img" aria-label="อ่านอย่างเดียว" title="อ่านอย่างเดียว (แก้ไขไม่ได้)" className="ml-1">🔒</span>}
                  {e.config && (
                    <button type="button" onClick={onOpenConfig} className="ml-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">แก้ในแท็บตั้งค่า</button>
                  )}
                </td>
                <td className="px-2 text-gray-600">{e.type === "file" ? size(e.size) : ""}</td>
                <td className="px-2 text-gray-600">{new Date(e.mtime).toLocaleString("th-TH")}</td>
                <td className="space-x-2 pl-2 text-right whitespace-nowrap">
                  {e.type === "file" && !e.secret && <button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => void openFile(e)}>เปิด</button>}
                  {e.type === "file" && !e.secret && <a className="text-blue-600 dark:text-blue-400 hover:underline" href={`${API_BASE}${base}/download?path=${encodeURIComponent(join(dir, e.name))}`}>ดาวน์โหลด</a>}
                  {!e.locked && <button type="button" disabled={busy} className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => { setNameDraft(e.name); setModalErr(null); setRenaming(e) }}>เปลี่ยนชื่อ</button>}
                  {!e.locked && <button type="button" disabled={busy} className="text-red-600 hover:underline" onClick={() => setDeleting(e)}>ลบ</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(newFolder || renaming) && (
        <Modal labelledBy="name-title" onClose={() => { setNewFolder(false); setRenaming(null) }} busy={busy}>
          <form onSubmit={(ev) => {
            ev.preventDefault()
            const n = nameDraft.trim()
            if (!validName(n)) { setModalErr(BAD_NAME); return }
            const req = renaming
              ? json("POST", { op: "rename", path: join(dir, renaming.name), newName: n })
              : json("POST", { op: "mkdir", parent: dir, name: n })
            void run(req, setModalErr).then((ok) => { if (ok) { setNewFolder(false); setRenaming(null) } })
          }}>
            <h2 id="name-title" className="text-lg font-semibold text-gray-900">{renaming ? `เปลี่ยนชื่อ ${renaming.name}` : "โฟลเดอร์ใหม่"}</h2>
            <label className="mt-3 block text-sm text-gray-700">ชื่อ
              <input data-autofocus value={nameDraft} onChange={(e) => { setNameDraft(e.target.value); setModalErr(null) }} autoComplete="off"
                aria-invalid={modalErr?.code === "invalid_filename"}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            {modalErr && <div className="mt-2"><ErrorNotice error={modalErr} /></div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} className={`${btn} border-gray-300`} onClick={() => { setNewFolder(false); setRenaming(null) }}>ยกเลิก</button>
              <button type="submit" disabled={busy || !nameDraft.trim()} className={`btn-primary px-3 py-1.5 text-sm`}>{busy ? "กำลังดำเนินการ..." : "ตกลง"}</button>
            </div>
          </form>
        </Modal>
      )}

      {overwrite && (
        <ConfirmDialog title={`เขียนทับ ${overwrite.name}?`} danger confirmLabel="เขียนทับ" onCancel={() => setOverwrite(null)}
          onConfirm={() => { const f = overwrite; setOverwrite(null); sendUpload(f) }}>
          มีไฟล์ชื่อนี้อยู่แล้ว ไฟล์เดิมจะถูกแทนที่ด้วยไฟล์ที่อัปโหลด กู้คืนไม่ได้
        </ConfirmDialog>
      )}

      {deleting && (
        <ConfirmDialog title={`ลบ ${deleting.name}?`} danger busy={busy} confirmLabel="ลบ" onCancel={() => setDeleting(null)}
          onConfirm={() => void run(() => apiFetch(`${base}?path=${encodeURIComponent(join(dir, deleting.name))}`, { method: "DELETE" })).then(() => setDeleting(null))}>
          {deleting.type === "dir" ? "โฟลเดอร์นี้และไฟล์ทั้งหมดข้างในจะถูกลบ กู้คืนไม่ได้" : "ไฟล์นี้จะถูกลบถาวร กู้คืนไม่ได้"}
        </ConfirmDialog>
      )}
    </div>
  )
}
