"use client"

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { Modal } from "./Modal"
import { IconFilePlus, IconFolderPlus, IconRefresh, IconUpload } from "./icons"
import { FileContextMenu } from "./files/FileContextMenu"
import { FileEditorModal } from "./files/FileEditorModal"
import { FileTree } from "./files/FileTree"
import { API_BASE, apiFetch, apiUpload } from "@/lib/ui/api"
import { cardCls, ghostBtnCls, inputCls, labelCls } from "@/lib/ui/classes"
import { joinPath as join, toggle, type Entry, type TreeRow, type TreeState } from "@/lib/ui/file-tree"

type Open = { path: string; content: string; hash: string; draft: string; readOnly: boolean }
type NameDialog = { kind: "rename"; row: TreeRow } | { kind: "mkdir" } | { kind: "newFile" }
type Upload = { name: string; index: number; count: number; percent: number }

const NETWORK: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const MAX_UPLOAD = 50 * 1024 * 1024
const tooLarge = (name: string): ApiError => ({ code: "too_large", message: `${name}: ไฟล์ใหญ่เกินกำหนด (สูงสุด 50 MB) ลดขนาดไฟล์แล้วลองใหม่` })
const EXTLIB = "agent/extlib"
const BAD_NAME: ApiError = { code: "invalid_filename", message: "ชื่อไฟล์/โฟลเดอร์ใช้ / \\ . .. หรือว่างไม่ได้ (ยาวไม่เกิน 255 ไบต์) แก้ชื่อแล้วลองใหม่" }
/** Same rule as the server (lib/mids/files.ts plainName), checked before sending. */
const validName = (n: string) => n !== "" && n !== "." && n !== ".." && !/[\\/\0]/.test(n) && new TextEncoder().encode(n).length <= 255
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/")
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)
/** dragOver value for "anywhere in the card": the drop goes to the upload target. */
const CARD = "\0card"
const EMPTY_TREE: TreeState = { children: {}, expanded: new Set() }
const toolBtn = "rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-blue-300"
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

type Props = { midName: string; /** Non-null while a lifecycle job runs: writes are disabled and this is the visible reason. */ busyReason?: string | null; /** Switch the MID panel to the config tab (config.xml / wrapper-override.conf rows). */ onOpenConfig: () => void }

/** Files tab container: tree state, API calls and dialogs. Rendering of the tree, menu and editor is in ./files. */
export function FilesTab({ midName, busyReason = null, onOpenConfig }: Props) {
  const base = `/mids/${encodeURIComponent(midName)}/files`
  const downloadHref = (path: string) => `${API_BASE}${base}/download?path=${encodeURIComponent(path)}`
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE)
  const [roDirs, setRoDirs] = useState<Record<string, boolean>>({})
  /** Upload target: the selected folder ("" is the MID root). */
  const [target, setTarget] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [err, setErr] = useState<ApiError | null>(null)
  const [modalErr, setModalErr] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  const [menu, setMenu] = useState<{ row: TreeRow; x: number; y: number } | null>(null)
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null)
  const [deleting, setDeleting] = useState<TreeRow | null>(null)
  const [overwrite, setOverwrite] = useState<File | null>(null)
  const overwriteAnswer = useRef<((ok: boolean) => void) | null>(null)
  const [upload, setUpload] = useState<Upload | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  const setChildren = (dir: string, v: TreeState["children"][string]) =>
    setTree((t) => ({ ...t, children: { ...t.children, [dir]: v } }))

  /** List one directory into the tree. Returns its entries, or null on failure (shown in the tree / page). */
  const load = useCallback(async (d: string): Promise<Entry[] | null> => {
    try {
      const res = await apiFetch(`${base}?path=${encodeURIComponent(d)}`)
      if (!res.ok) {
        const e = await readApiError(res)
        setTree((t) => ({ ...t, children: { ...t.children, [d]: { error: e.message } } }))
        if (d === "") setErr(e)
        return null
      }
      const j = (await res.json()) as { entries: Entry[]; readOnly?: boolean }
      setTree((t) => ({ ...t, children: { ...t.children, [d]: j.entries } }))
      setRoDirs((r) => ({ ...r, [d]: j.readOnly === true }))
      return j.entries
    } catch {
      setTree((t) => ({ ...t, children: { ...t.children, [d]: { error: NETWORK.message } } }))
      if (d === "") setErr(NETWORK)
      return null
    }
  }, [base])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTree(EMPTY_TREE); setRoDirs({}); setTarget(""); setSelected(null)
    void load("")
  }, [load])

  function refresh() {
    setErr(null)
    for (const d of ["", ...tree.expanded]) void load(d)
  }

  /** Drop cached listings at or below a renamed/deleted path. */
  function forget(path: string) {
    setTree((t) => ({
      children: Object.fromEntries(Object.entries(t.children).filter(([k]) => !under(k, path))),
      expanded: new Set([...t.expanded].filter((k) => !under(k, path))),
    }))
    if (under(target, path)) setTarget(parentOf(path))
    if (selected && under(selected, path)) setSelected(null)
  }

  /** Expand `path` and all its ancestors, list the ones not loaded yet, and make it the upload target. */
  function reveal(path: string) {
    const chain = path.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"))
    setTree((t) => ({ ...t, expanded: new Set([...t.expanded, ...chain]) }))
    for (const d of chain) if (!Array.isArray(tree.children[d])) { setChildren(d, "loading"); void load(d) }
    setTarget(path); setSelected(path)
  }

  function onRowClick(row: TreeRow) {
    setSelected(row.path)
    if (row.entry.type === "dir") {
      setTarget(row.path)
      const opening = !tree.expanded.has(row.path)
      setTree((t) => toggle(t, row.path))
      if (opening && !Array.isArray(tree.children[row.path])) { setChildren(row.path, "loading"); void load(row.path) }
      return
    }
    setTarget(parentOf(row.path))
    if (!row.entry.secret) void openFile(row.path, row.entry.readOnly)
  }

  /** `onErr` decides where a failure is shown (the open dialog, or the page) so it never appears twice. */
  async function run(fn: () => Promise<Response>, reloadDir: string, onErr: (e: ApiError) => void = setErr): Promise<boolean> {
    if (busyReason) { onErr({ message: busyReason }); return false }
    setBusy(true); setErr(null); setModalErr(null)
    try {
      const res = await fn()
      if (!res.ok) { onErr(await readApiError(res)); return false }
      await load(reloadDir)
      return true
    } catch { onErr(NETWORK); return false } finally { setBusy(false) }
  }
  const json = (method: string, body: object) => () =>
    apiFetch(base, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  async function openFile(path: string, readOnly: boolean) {
    setErr(null)
    try {
      const res = await apiFetch(`${base}?path=${encodeURIComponent(path)}&content=1`)
      if (!res.ok) { setErr(await readApiError(res)); return }
      const j = (await res.json()) as { content: string; hash: string }
      setSaved(false)
      setSelected(path)
      setOpen({ path, content: j.content, hash: j.hash, draft: j.content, readOnly })
    } catch { setErr(NETWORK) }
  }

  /** Ctrl/Cmd+S and the Save button: nothing is sent without changes, for a read-only file, or during a job. */
  async function save() {
    if (!open || open.readOnly || busy || busyReason || open.draft === open.content) return
    setBusy(true); setErr(null); setSaved(false)
    try {
      const res = await apiFetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: open.path, content: open.draft, baseHash: open.hash }) })
      if (!res.ok) { setErr(await readApiError(res)); return }
      const j = (await res.json()) as { hash: string }
      setOpen((o) => (o && o.path === open.path ? { ...o, content: open.draft, hash: j.hash } : o))
      setSaved(true)
      void load(parentOf(open.path))
    } catch { setErr(NETWORK) } finally { setBusy(false) }
  }

  async function reloadOpen() {
    if (!open) return
    const { path, readOnly } = open
    setOpen(null)
    await openFile(path, readOnly)
  }
  const closeEditor = () => { setOpen(null); setErr(null); setSaved(false); setConfirmClose(false) }

  /** Ask the overwrite confirm for one file; resolves with the answer. */
  const askOverwrite = (f: File) => new Promise<boolean>((resolve) => { overwriteAnswer.current = resolve; setOverwrite(f) })
  function answerOverwrite(ok: boolean) {
    overwriteAnswer.current?.(ok)
    overwriteAnswer.current = null
    setOverwrite(null)
  }

  /** Upload one file at a time (the server takes one), each after the size check and overwrite confirm. */
  async function uploadFiles(dir: string, files: File[]) {
    if (files.length === 0 || busy) return
    if (busyReason) { setErr({ message: busyReason }); return }
    setErr(null); setBusy(true)
    let failed = false
    const fail = (e: ApiError) => { if (!failed) setErr(e); failed = true }
    try {
      const listing = Array.isArray(tree.children[dir]) ? (tree.children[dir] as Entry[]) : await load(dir)
      for (const [i, f] of files.entries()) {
        if (f.size > MAX_UPLOAD) { fail(tooLarge(f.name)); continue }
        if (listing?.some((x) => x.name === f.name && x.type === "file") && !(await askOverwrite(f))) continue
        setUpload({ name: f.name, index: i + 1, count: files.length, percent: 0 })
        const fd = new FormData()
        fd.set("dir", dir)
        fd.set("file", f)
        try {
          const res = await apiUpload(base, fd, (percent) => setUpload((u) => (u ? { ...u, percent } : u)))
          if (!res.ok) { fail(await readApiError(res)); break }
        } catch { fail(NETWORK); break }
      }
    } finally {
      setUpload(null); setBusy(false)
      await load(dir)
    }
  }

  /** Drag handlers for one drop target. `key` is what gets highlighted; `dir` is where files land. */
  const dropHandlers = (key: string, dir: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); e.stopPropagation()
      setDragOver(key)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); e.stopPropagation()
      setDragOver(null)
      void uploadFiles(dir, Array.from(e.dataTransfer.files))
    },
  })

  function submitName() {
    const n = nameDraft.trim()
    if (!validName(n)) { setModalErr(BAD_NAME); return }
    const d = nameDialog
    if (!d) return
    const done = (ok: boolean) => { if (ok) setNameDialog(null) }
    if (d.kind === "rename") {
      const from = d.row.path
      void run(json("POST", { op: "rename", path: from, newName: n }), parentOf(from), setModalErr).then((ok) => { if (ok) forget(from); done(ok) })
    } else if (d.kind === "mkdir") {
      void run(json("POST", { op: "mkdir", parent: target, name: n }), target, setModalErr).then(done)
    } else {
      const path = join(target, n)
      void run(json("PUT", { path, content: "", baseHash: "" }), target, setModalErr).then((ok) => {
        done(ok)
        if (ok) void openFile(path, false)
      })
    }
  }
  const startName = (d: NameDialog, initial: string) => { setNameDraft(initial); setModalErr(null); setNameDialog(d) }

  const crumbs = target ? target.split("/") : []
  const targetRo = roDirs[target] === true
  const writeOff = busy || !!busyReason || targetRo
  const rootErr = typeof tree.children[""] === "object" && !Array.isArray(tree.children[""])
  const nameTitle = nameDialog?.kind === "rename" ? `Rename ${nameDialog.row.entry.name}` : nameDialog?.kind === "mkdir" ? "New Folder" : "New File"

  return (
    <div className="space-y-3">
      {busyReason && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{busyReason} — แก้ไขไฟล์ไม่ได้จนกว่างานจะเสร็จ</p>}
      {targetRo && (
        <p id="ro-hint" className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          🔒 โฟลเดอร์โปรแกรมของ MID แก้ไขไม่ได้ — อัปโหลด library ที่{" "}
          <button type="button" className="font-mono text-blue-600 dark:text-blue-400 hover:underline" onClick={() => reveal(EXTLIB)}>{EXTLIB}</button> แทน
        </p>
      )}
      {target === EXTLIB && <p className="text-sm text-gray-600 dark:text-neutral-400">jar ใน extlib จะถูกลบตอน MID เริ่มทำงาน ถ้าไม่ได้ลงทะเบียนเป็น MID Server JAR File ใน instance</p>}
      {err && !open && !nameDialog && <ErrorNotice error={err} />}

      <div data-testid="files-card" {...dropHandlers(CARD, target)}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null) }}
        className={`${cardCls} relative overflow-hidden ${dragOver === CARD ? "ring-2 ring-inset ring-blue-500" : ""}`}>
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-neutral-700">
          <nav aria-label="Upload Target" className={`flex min-w-0 flex-1 flex-wrap items-center text-xs ${dragOver === CARD ? "text-blue-600 dark:text-blue-300" : "text-gray-500 dark:text-neutral-400"}`}>
            <button type="button" className="hover:text-blue-600 hover:underline dark:hover:text-blue-300" onClick={() => { setTarget(""); setSelected(null) }}>{midName}</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center">
                <span aria-hidden="true">/</span>
                <button type="button" className="hover:text-blue-600 hover:underline dark:hover:text-blue-300" onClick={() => { const p = crumbs.slice(0, i + 1).join("/"); setTarget(p); setSelected(p) }}>{c}</button>
              </span>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            <input ref={fileInput} type="file" multiple hidden aria-label="Choose Files to Upload"
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void uploadFiles(target, fs) }} />
            <button type="button" title="Upload" aria-label="Upload" disabled={writeOff} aria-describedby={targetRo ? "ro-hint" : undefined}
              onClick={() => fileInput.current?.click()} className={toolBtn}><IconUpload /></button>
            <button type="button" title="New File" aria-label="New File" disabled={writeOff} aria-describedby={targetRo ? "ro-hint" : undefined}
              onClick={() => startName({ kind: "newFile" }, "")} className={toolBtn}><IconFilePlus /></button>
            <button type="button" title="New Folder" aria-label="New Folder" disabled={writeOff} aria-describedby={targetRo ? "ro-hint" : undefined}
              onClick={() => startName({ kind: "mkdir" }, "")} className={toolBtn}><IconFolderPlus /></button>
            <button type="button" title="Refresh" aria-label="Refresh" disabled={busy} onClick={refresh} className={toolBtn}><IconRefresh /></button>
          </div>
        </div>

        {upload && (
          <div className="border-b border-gray-100 px-3 py-2 dark:border-neutral-700">
            <div className="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-neutral-400">
              <span className="truncate">Uploading {upload.name}{upload.count > 1 ? ` (${upload.index}/${upload.count})` : ""}</span>
              <span className="tabular-nums">{upload.percent}%</span>
            </div>
            <div role="progressbar" aria-label={`Uploading ${upload.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.percent}
              className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${upload.percent}%` }} />
            </div>
          </div>
        )}

        {!rootErr && (
          <FileTree state={tree} selected={selected} dragOver={dragOver}
            onRowClick={onRowClick} onMenu={(row, x, y) => setMenu({ row, x, y })} dropProps={(dir) => dropHandlers(dir, dir)} />
        )}
        <p className="border-t border-gray-100 px-3 py-1.5 text-xs text-gray-400 dark:border-neutral-700 dark:text-neutral-500">
          ลากไฟล์มาวางบนโฟลเดอร์เพื่ออัปโหลด (สูงสุด 50 MB ต่อไฟล์)
        </p>
      </div>

      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} entry={menu.row.entry} downloadHref={downloadHref(menu.row.path)}
          writeDisabled={busy || !!busyReason} onClose={() => setMenu(null)}
          onOpen={() => void openFile(menu.row.path, menu.row.entry.readOnly)}
          onRename={() => startName({ kind: "rename", row: menu.row }, menu.row.entry.name)}
          onDelete={() => setDeleting(menu.row)}
          onOpenConfig={onOpenConfig} />
      )}

      {open && (
        <FileEditorModal midName={midName} path={open.path} value={open.draft} readOnly={open.readOnly}
          dirty={open.draft !== open.content} saved={saved} saving={busy} busyReason={busyReason} error={err}
          downloadHref={downloadHref(open.path)}
          onChange={(v) => { setSaved(false); setOpen((o) => (o ? { ...o, draft: v } : o)) }}
          onSave={() => void save()}
          onClose={() => (open.draft !== open.content ? setConfirmClose(true) : closeEditor())}
          onReload={() => void reloadOpen()} />
      )}
      {confirmClose && (
        <ConfirmDialog title="Close Without Saving?" danger confirmLabel="Close" onCancel={() => setConfirmClose(false)} onConfirm={closeEditor}>
          มีการแก้ไขที่ยังไม่บันทึก ถ้าปิดตอนนี้ การแก้ไขจะหาย
        </ConfirmDialog>
      )}

      {nameDialog && (
        <Modal labelledBy="name-title" onClose={() => setNameDialog(null)} busy={busy}>
          <form onSubmit={(ev) => { ev.preventDefault(); submitName() }}>
            <h2 id="name-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-100">{nameTitle}</h2>
            {nameDialog.kind !== "rename" && <p className="mt-1 break-all text-xs text-gray-500 dark:text-neutral-400">ใน {target ? `${midName}/${target}` : midName}</p>}
            <label className={`${labelCls} mt-3`}>Name
              <input data-autofocus value={nameDraft} onChange={(e) => { setNameDraft(e.target.value); setModalErr(null) }} autoComplete="off"
                aria-invalid={modalErr?.code === "invalid_filename"} className={`${inputCls} mt-1`} /></label>
            {modalErr && <div className="mt-2"><ErrorNotice error={modalErr} /></div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} className={ghostBtnCls} onClick={() => setNameDialog(null)}>Cancel</button>
              <button type="submit" disabled={busy || !nameDraft.trim()} className="btn-primary px-4 py-2 text-sm font-medium">{busy ? "Working…" : "Confirm"}</button>
            </div>
          </form>
        </Modal>
      )}

      {overwrite && (
        <ConfirmDialog title={`Overwrite ${overwrite.name}?`} danger confirmLabel="Overwrite" onCancel={() => answerOverwrite(false)} onConfirm={() => answerOverwrite(true)}>
          มีไฟล์ชื่อนี้อยู่แล้ว ไฟล์เดิมจะถูกแทนที่ด้วยไฟล์ที่อัปโหลด กู้คืนไม่ได้
        </ConfirmDialog>
      )}

      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.entry.name}?`} danger busy={busy} confirmLabel="Delete" onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const row = deleting
            void run(() => apiFetch(`${base}?path=${encodeURIComponent(row.path)}`, { method: "DELETE" }), parentOf(row.path))
              .then((ok) => { if (ok) forget(row.path); setDeleting(null) })
          }}>
          {deleting.entry.type === "dir" ? "โฟลเดอร์นี้และไฟล์ทั้งหมดข้างในจะถูกลบ กู้คืนไม่ได้" : "ไฟล์นี้จะถูกลบถาวร กู้คืนไม่ได้"}
        </ConfirmDialog>
      )}
    </div>
  )
}
