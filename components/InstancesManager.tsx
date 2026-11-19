"use client"

import { useEffect, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { cardCls, ghostBtnCls, inputCls, labelCls, tableCardCls, theadCls, trHoverCls } from "@/lib/ui/classes"

type Instance = {
  id: string; label: string; url: string; midUser: string | null; hasPassword: boolean
  buildstamp: string | null; createdBy: string; createdAt: string
}

const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const jsonInit = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

export function InstancesManager() {
  const [items, setItems] = useState<Instance[]>([])
  const [label, setLabel] = useState("")
  const [url, setUrl] = useState("")
  const [midUser, setMidUser] = useState("")
  const [password, setPassword] = useState("")
  const [editing, setEditing] = useState<Instance | null>(null)
  const [eLabel, setELabel] = useState("")
  const [eUser, setEUser] = useState("")
  const [ePass, setEPass] = useState("")
  const [err, setErr] = useState<ApiError | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [del, setDel] = useState<Instance | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    apiFetch("/instances")
      .then(async (r) => (r.ok ? setItems((await r.json()) as Instance[]) : setErr(await readApiError(r))))
      .catch(() => setErr(NET))
  }, [reload])

  async function call(path: string, init: RequestInit): Promise<Response | null> {
    setErr(null); setInfo(null); setBusy(true)
    try {
      const res = await apiFetch(path, init)
      if (!res.ok) { setErr(await readApiError(res)); return null }
      return res
    } catch {
      setErr(NET)
      return null
    } finally {
      setBusy(false)
    }
  }

  const formReady = url.trim() !== "" && midUser.trim() !== "" && password !== ""
  const reason = busy ? "กำลังดำเนินการ (ทดสอบการเชื่อมต่ออาจใช้เวลาถึง 15 วินาที) กรุณารอ..."
    : formReady ? undefined : "กรอก URL, MID user และ password ให้ครบก่อน"

  async function test() {
    const res = await call("/instances/test", jsonInit("POST", { url, midUser, password, label }))
    if (!res) return
    const j = (await res.json()) as { buildstamp: string | null }
    setInfo(`เชื่อมต่อสำเร็จ${j.buildstamp ? ` (build: ${j.buildstamp})` : ""}`)
  }
  async function add() {
    const res = await call("/instances", jsonInit("POST", { label, url, midUser, password }))
    if (!res) return
    setLabel(""); setUrl(""); setMidUser(""); setPassword("")
    setInfo("บันทึก instance แล้ว")
    setReload((n) => n + 1)
  }
  function startEdit(i: Instance) {
    setEditing(i); setELabel(i.label); setEUser(i.midUser ?? ""); setEPass(""); setErr(null); setInfo(null)
  }
  async function saveEdit() {
    if (!editing) return
    const body: Record<string, string> = {}
    if (!eLabel.trim()) { setErr({ message: "ชื่อเรียกต้องไม่ว่าง" }); return }
    if (eLabel.trim() && eLabel !== editing.label) body.label = eLabel
    if (eUser.trim() && eUser !== (editing.midUser ?? "")) body.midUser = eUser
    if (ePass) body.password = ePass
    if (!editing.hasPassword && !ePass && eUser.trim()) {
      setErr({ message: "ต้องใส่ password ด้วยเมื่อตั้ง MID user ครั้งแรก" }); return
    }
    if (Object.keys(body).length === 0) { setEditing(null); return }
    const res = await call(`/instances/${encodeURIComponent(editing.id)}`, jsonInit("POST", body) /* not PATCH: the F5 WAF rejects it */)
    if (!res) return
    setEditing(null); setEPass("")
    setInfo("บันทึกแล้ว")
    setReload((n) => n + 1)
  }
  async function confirmDelete() {
    if (!del) return
    const res = await call(`/instances/${encodeURIComponent(del.id)}`, { method: "DELETE" })
    setDel(null)
    if (res) setReload((n) => n + 1)
  }

  return (
    <section>
      <h1 className="mb-2 text-lg font-semibold text-gray-900">Instances</h1>
      <p className="mb-4 text-sm text-gray-600">
        เก็บ URL ของ demo instance พร้อม MID user/password (เข้ารหัสไว้ ไม่แสดงกลับ) เพื่อใช้ตอนติดตั้ง MID ใหม่
        ทุกครั้งที่บันทึกจะทดสอบการเชื่อมต่อก่อน
      </p>
      <form className={`${cardCls} mb-3 grid gap-3 p-4 sm:grid-cols-2`} onSubmit={(e) => { e.preventDefault(); if (formReady) void add() }}>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="inst-url">Instance URL</label>
          <input id="inst-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://<name>.service-now.com" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="inst-label">Display Name (Optional)</label>
          <input id="inst-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ใช้ชื่อโฮสต์ถ้าเว้นว่าง" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="inst-user">MID user</label>
          <input id="inst-user" value={midUser} onChange={(e) => setMidUser(e.target.value)} autoComplete="off" className={inputCls} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="inst-pass">Password</label>
          <input id="inst-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={inputCls} />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">
          <button type="button" disabled={busy || !formReady} onClick={() => void test()} className={ghostBtnCls}>Test Connection</button>
          <button type="submit" disabled={busy || !formReady} className="btn-primary px-4 py-2 text-sm font-medium">Save</button>
          {reason && <span className="text-xs text-gray-500">{reason}</span>}
        </div>
      </form>
      {err && <div className="mb-2"><ErrorNotice error={err} /></div>}
      {info && <p role="status" className="mb-2 text-sm text-green-700 dark:text-green-400">{info}</p>}
      {editing && (
        <form className={`${cardCls} mb-3 grid gap-3 p-4 sm:grid-cols-3`} onSubmit={(e) => { e.preventDefault(); void saveEdit() }}>
          <p className="text-sm text-gray-700 sm:col-span-3">Edit <span className="font-mono text-xs">{editing.url}</span></p>
          <div>
            <label className={labelCls} htmlFor="e-label">Display Name</label>
            <input id="e-label" value={eLabel} onChange={(e) => setELabel(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="e-user">MID user</label>
            <input id="e-user" value={eUser} onChange={(e) => setEUser(e.target.value)} autoComplete="off" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="e-pass">Password</label>
            <input id="e-pass" type="password" value={ePass} onChange={(e) => setEPass(e.target.value)} autoComplete="new-password"
              placeholder={editing.hasPassword ? "ตั้งไว้แล้ว (เว้นว่าง = ไม่เปลี่ยน)" : "Not Set"} className={inputCls} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-3">
            <button type="submit" disabled={busy} className="btn-primary px-4 py-2 text-sm font-medium">Test and Save</button>
            {busy && <span className="self-center text-xs text-gray-500">กำลังทดสอบการเชื่อมต่อ อาจใช้เวลาถึง 15 วินาที กรุณารอ...</span>}
            <button type="button" onClick={() => setEditing(null)} className={ghostBtnCls}>Cancel</button>
          </div>
        </form>
      )}
      <div className={tableCardCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}>
            <tr>
              <th className="px-4 py-2 font-medium">Name</th><th className="px-4 py-2 font-medium">URL</th><th className="px-4 py-2 font-medium">MID user</th>
              <th className="px-4 py-2 font-medium">Password</th><th className="px-4 py-2 font-medium">Build</th>
              <th className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((i) => (
              <tr key={i.id} className={trHoverCls}>
                <td className="whitespace-nowrap px-4 py-2 text-gray-900">{i.label}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-gray-700">{i.url}</td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-700">{i.midUser ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-500">{i.hasPassword ? "Set" : "Not Set"}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-gray-500">{i.buildstamp ?? "—"}</td>
                <td className="space-x-3 whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="text-blue-600 hover:underline dark:text-blue-400" onClick={() => startEdit(i)}>Edit</button>
                  <button type="button" className="text-red-600 hover:underline" onClick={() => setDel(i)}>Delete</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No Instances</td></tr>}
          </tbody>
        </table>
      </div>
      {del && (
        <ConfirmDialog title={`Delete Instance ${del.label}?`} confirmLabel="Delete" danger busy={busy}
          onCancel={() => setDel(null)} onConfirm={() => void confirmDelete()}>
          credentials ที่เก็บไว้จะถูกลบ การลบไม่สามารถย้อนกลับได้ (ลบไม่ได้ถ้ายังมี MID ใช้ instance นี้อยู่)
        </ConfirmDialog>
      )}
    </section>
  )
}
