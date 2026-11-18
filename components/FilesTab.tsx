"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useRef, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { Modal } from "./Modal"
import { API_BASE, apiFetch } from "@/lib/ui/api"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false })

type Entry = { name: string; type: "file" | "dir"; size: number; mtime: string; readOnly: boolean }
type Open = { path: string; content: string; hash: string; draft: string }

const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const MAX_UPLOAD = 50 * 1024 * 1024
const btn = "rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
const join = (a: string, b: string) => (a ? `${a}/${b}` : b)
const LANGS: Record<string, string> = { xml: "xml", json: "json", conf: "ini", properties: "ini", sh: "shell", js: "javascript", yaml: "yaml", yml: "yaml", md: "markdown", log: "plaintext" }
const lang = (n: string) => LANGS[n.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"
function size(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function FilesTab({ midName }: { midName: string }) {
  const base = `/mids/${encodeURIComponent(midName)}/files`
  const [dir, setDir] = useState("")
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [err, setErr] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const [newFolder, setNewFolder] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async (d: string) => {
    try {
      const res = await apiFetch(`${base}?path=${encodeURIComponent(d)}`)
      if (!res.ok) { setErr(await readApiError(res)); return }
      setErr(null)
      setEntries(((await res.json()) as { entries: Entry[] }).entries)
    } catch { setErr(NETWORK) }
  }, [base])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(dir) }, [load, dir])

  async function run(fn: () => Promise<Response>, after?: () => void): Promise<boolean> {
    setBusy(true); setErr(null)
    try {
      const res = await fn()
      if (!res.ok) { setErr(await readApiError(res)); return false }
      after?.()
      await load(dir)
      return true
    } catch { setErr(NETWORK); return false } finally { setBusy(false) }
  }
  const json = (method: string, body: object) => () =>
    apiFetch(base, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  async function openFile(e: Entry) {
    setErr(null)
    try {
      const res = await apiFetch(`${base}?path=${encodeURIComponent(join(dir, e.name))}&content=1`)
      if (!res.ok) { setErr(await readApiError(res)); return }
      const j = (await res.json()) as { content: string; hash: string }
      setOpen({ path: join(dir, e.name), content: j.content, hash: j.hash, draft: j.content })
    } catch { setErr(NETWORK) }
  }

  async function save() {
    if (!open) return
    setBusy(true); setErr(null)
    try {
      const res = await apiFetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: open.path, content: open.draft, baseHash: open.hash }) })
      if (!res.ok) { setErr(await readApiError(res)); return }
      const j = (await res.json()) as { hash: string }
      setOpen({ ...open, content: open.draft, hash: j.hash })
      await load(dir)
    } catch { setErr(NETWORK) } finally { setBusy(false) }
  }

  async function reloadOpen() {
    if (!open) return
    const name = open.path.split("/").pop() ?? ""
    setOpen(null)
    await openFile({ name, type: "file", size: 0, mtime: "", readOnly: false })
  }

  function onPick(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = ""
    if (!f) return
    if (f.size > MAX_UPLOAD) { setErr({ code: "too_large", message: "ไฟล์ใหญ่เกินกำหนด (สูงสุด 50 MB) ลดขนาดไฟล์แล้วลองใหม่" }); return }
    const fd = new FormData()
    fd.set("dir", dir)
    fd.set("file", f)
    void run(() => apiFetch(base, { method: "POST", body: fd }))
  }

  const crumbs = dir ? dir.split("/") : []
  const stale = err?.code === "stale"

  if (open) {
    const dirty = open.draft !== open.content
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${btn} border-gray-300`} onClick={() => { if (!dirty || window.confirm("มีการแก้ไขที่ยังไม่บันทึก ปิดโดยไม่บันทึกหรือไม่?")) { setOpen(null); setErr(null) } }}>← กลับ</button>
          <span className="font-mono text-sm text-gray-800">{open.path}</span>
          <button type="button" disabled={busy || !dirty} onClick={() => void save()}
            className={`${btn} ml-auto border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>{busy ? "กำลังบันทึก..." : "บันทึก"}</button>
        </div>
        {err && (
          <div className="space-y-2">
            <ErrorNotice error={err} />
            {stale && <button type="button" className={`${btn} border-gray-300`} onClick={() => void reloadOpen()}>โหลดไฟล์ใหม่ (การแก้ไขที่ยังไม่บันทึกจะหาย)</button>}
          </div>
        )}
        <div className="h-96 overflow-hidden rounded-lg border border-gray-300">
          <MonacoEditor height="100%" language={lang(open.path)} path={`${midName}/${open.path}`} value={open.draft}
            onChange={(v) => setOpen((o) => (o ? { ...o, draft: v ?? "" } : o))} options={{ minimap: { enabled: false }, scrollBeyondLastLine: false }} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="ตำแหน่งโฟลเดอร์" className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="text-blue-600 hover:underline" onClick={() => setDir("")}>{midName}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-gray-400">/</span>
              <button type="button" className="text-blue-600 hover:underline" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" hidden aria-label="เลือกไฟล์อัปโหลด" onChange={(e) => onPick(e.target.files?.[0])} />
          <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className={`${btn} border-gray-300 text-gray-800 hover:bg-gray-50`}>อัปโหลดไฟล์</button>
          <span className="text-xs text-gray-500">สูงสุด 50 MB ต่อไฟล์</span>
          <button type="button" disabled={busy} onClick={() => { setNameDraft(""); setNewFolder(true) }} className={`${btn} border-gray-300 text-gray-800 hover:bg-gray-50`}>โฟลเดอร์ใหม่</button>
        </div>
      </div>

      {err && <ErrorNotice error={err} />}

      {entries === null ? (
        !err && <p className="text-sm text-gray-500">กำลังโหลด...</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr><th className="py-1 pr-2">ชื่อ</th><th className="px-2">ขนาด</th><th className="px-2">แก้ไขล่าสุด</th><th className="pl-2 text-right">จัดการ</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {dir && (
              <tr><td colSpan={4} className="py-1.5"><button type="button" className="text-blue-600 hover:underline" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}>📁 ..</button></td></tr>
            )}
            {entries.length === 0 && <tr><td colSpan={4} className="py-3 text-gray-500">โฟลเดอร์ว่าง</td></tr>}
            {entries.map((e) => (
              <tr key={e.name}>
                <td className="py-1.5 pr-2">
                  <span aria-hidden>{e.type === "dir" ? "📁" : "📄"} </span>
                  {e.type === "dir"
                    ? <button type="button" className="text-blue-700 hover:underline" onClick={() => setDir(join(dir, e.name))}>{e.name}</button>
                    : <span>{e.name}</span>}
                  {e.readOnly && <span role="img" aria-label="อ่านอย่างเดียว" title="อ่านอย่างเดียว (แก้ไขไม่ได้)" className="ml-1">🔒</span>}
                </td>
                <td className="px-2 text-gray-600">{e.type === "file" ? size(e.size) : ""}</td>
                <td className="px-2 text-gray-600">{new Date(e.mtime).toLocaleString("th-TH")}</td>
                <td className="space-x-2 pl-2 text-right whitespace-nowrap">
                  {e.type === "file" && <button type="button" className="text-blue-600 hover:underline" onClick={() => void openFile(e)}>เปิด</button>}
                  {e.type === "file" && <a className="text-blue-600 hover:underline" href={`${API_BASE}${base}/download?path=${encodeURIComponent(join(dir, e.name))}`}>ดาวน์โหลด</a>}
                  {!e.readOnly && <button type="button" disabled={busy} className="text-blue-600 hover:underline" onClick={() => { setNameDraft(e.name); setRenaming(e) }}>เปลี่ยนชื่อ</button>}
                  {!e.readOnly && <button type="button" disabled={busy} className="text-red-600 hover:underline" onClick={() => setDeleting(e)}>ลบ</button>}
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
            if (!n) return
            const req = renaming
              ? json("POST", { op: "rename", path: join(dir, renaming.name), newName: n })
              : json("POST", { op: "mkdir", parent: dir, name: n })
            void run(req).then((ok) => { if (ok) { setNewFolder(false); setRenaming(null) } })
          }}>
            <h2 id="name-title" className="text-lg font-semibold text-gray-900">{renaming ? `เปลี่ยนชื่อ ${renaming.name}` : "โฟลเดอร์ใหม่"}</h2>
            <label className="mt-3 block text-sm text-gray-700">ชื่อ
              <input data-autofocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} autoComplete="off"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            {err && <div className="mt-2"><ErrorNotice error={err} /></div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} className={`${btn} border-gray-300`} onClick={() => { setNewFolder(false); setRenaming(null) }}>ยกเลิก</button>
              <button type="submit" disabled={busy || !nameDraft.trim()} className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>{busy ? "กำลังดำเนินการ..." : "ตกลง"}</button>
            </div>
          </form>
        </Modal>
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
