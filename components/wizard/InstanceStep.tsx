"use client"

import { useCallback, useEffect, useState } from "react"
import { ErrorNotice, readApiError, type ApiError } from "../ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { cardCls, ghostBtnCls, inputCls, labelCls } from "@/lib/ui/classes"
import { BUILDSTAMP_RE, type WizardState } from "@/lib/ui/wizard"

export type InstanceItem = {
  id: string; label: string; url: string; midUser: string | null; hasPassword: boolean
  buildstamp: string | null; createdBy: string; createdAt: string
}
type Props = { isAdmin: boolean; state: WizardState; onChange: (p: Partial<WizardState>) => void; onLabel: (label: string) => void }

const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }
const jsonInit = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
const host = (u: string) => { try { return new URL(u).host } catch { return u } }
const date = (iso: string) => { try { return new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) } catch { return iso } }

export function InstanceStep({ isAdmin, state, onChange, onLabel }: Props) {
  const [items, setItems] = useState<InstanceItem[] | null>(null)
  const [packages, setPackages] = useState<{ buildstamp: string; bytes: number }[]>([])
  const [loadErr, setLoadErr] = useState<ApiError | null>(null)
  const [err, setErr] = useState<ApiError | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState("")
  const [url, setUrl] = useState("")
  const [midUser, setMidUser] = useState("")
  const [password, setPassword] = useState("")
  const [fixUser, setFixUser] = useState("")
  const [fixPass, setFixPass] = useState("")

  const load = useCallback(async (): Promise<InstanceItem[] | null> => {
    try {
      const res = await apiFetch("/instances")
      if (!res.ok) { setLoadErr(await readApiError(res)); return null }
      const list = (await res.json()) as InstanceItem[]
      setItems(list); setLoadErr(null)
      return list
    } catch {
      setLoadErr(NET)
      return null
    }
  }, [])
  // Deferred one microtask so the effect body itself never sets state synchronously.
  useEffect(() => { void Promise.resolve().then(load) }, [load])
  useEffect(() => {
    apiFetch("/packages").then(async (r) => { if (r.ok) setPackages((await r.json()) as { buildstamp: string; bytes: number }[]) }).catch(() => undefined)
  }, [])

  const pick = (i: InstanceItem) => {
    setErr(null); setInfo(null); setAdding(false)
    onLabel(`${i.label} (${host(i.url)})`)
    onChange({ instance: { id: i.id, hasPassword: i.hasPassword, buildstamp: i.buildstamp }, pendingNew: false, buildstamp: "" })
  }
  const startAdd = () => {
    setAdding(true); setErr(null); setInfo(null)
    onChange({ instance: null, pendingNew: true })
  }
  const cancelAdd = () => { setAdding(false); onChange({ pendingNew: false }) }

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

  const addReady = url.trim() !== "" && midUser.trim() !== "" && password !== ""
  const addReason = busy ? "กำลังทดสอบการเชื่อมต่อ (ใช้เวลาได้ถึง 15 วินาที) กรุณารอ..." : addReady ? undefined : "กรอก URL, MID user และรหัสผ่านให้ครบก่อน"

  async function testOnly() {
    const res = await call("/instances/test", jsonInit("POST", { url, midUser, password }))
    if (!res) return
    const j = (await res.json()) as { buildstamp: string | null }
    setInfo(`เชื่อมต่อสำเร็จ${j.buildstamp ? ` (build: ${j.buildstamp})` : ""} กด “Test and Save” เพื่อใช้ instance นี้`)
  }
  async function saveNew() {
    let lbl = label.trim()
    if (!lbl) { try { lbl = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname.split(".")[0] } catch { lbl = url.trim() } }
    const res = await call("/instances", jsonInit("POST", { label: lbl, url, midUser, password }))
    if (!res) return
    const created = (await res.json()) as InstanceItem
    setLabel(""); setUrl(""); setMidUser(""); setPassword(""); setAdding(false)
    await load()
    pick(created) // the server tested the credentials before saving, so this instance is ready
    setInfo("เชื่อมต่อสำเร็จและบันทึก instance แล้ว")
  }
  async function saveCreds(i: InstanceItem) {
    const res = await call(`/instances/${encodeURIComponent(i.id)}`, jsonInit("POST", { midUser: fixUser, password: fixPass }) /* not PATCH: the F5 WAF rejects it */)
    if (!res) return
    const updated = (await res.json()) as InstanceItem
    setFixUser(""); setFixPass("")
    await load()
    pick(updated)
    setInfo("บันทึกรหัสแล้ว")
  }

  const sel = items?.find((i) => i.id === state.instance?.id) ?? null
  const bs = state.buildstamp.trim()

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Select Instance</h3>
        <p className="mt-0.5 text-sm text-gray-600">เลือกจากที่บันทึกไว้ หรือเพิ่ม instance ใหม่</p>
      </div>
      {loadErr && <ErrorNotice error={loadErr} />}
      {items === null && !loadErr && <p className="text-sm text-gray-500">Loading…</p>}
      {items && items.length === 0 && !adding && <p className="text-sm text-gray-600">ยังไม่มี instance ที่บันทึกไว้ กด “Add Instance”</p>}

      {items && items.length > 0 && (
        <ul role="radiogroup" aria-label="Saved Instances" className="space-y-2">
          {items.map((i) => {
            const on = state.instance?.id === i.id
            return (
              <li key={i.id}>
                <label className={`block cursor-pointer rounded-lg border px-3 py-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500 ${on ? "border-blue-500 bg-blue-50 ring-1 ring-blue-300" : "border-gray-200 hover:bg-gray-50"}`}>
                  <input type="radio" name="wizard-instance" className="sr-only" checked={on} onChange={() => pick(i)} />
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-blue-600" : "border-gray-400"}`} aria-hidden>
                      {on && <span className="h-2 w-2 rounded-full bg-blue-600" />}
                    </span>
                    <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-neutral-100">{i.label}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${i.hasPassword ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                      {i.hasPassword ? "Has Password" : "No Password"}
                    </span>
                  </span>
                  <span className="mt-0.5 block break-all pl-6 text-xs text-gray-600">{host(i.url)}</span>
                  <span className="mt-0.5 block break-all pl-6 text-xs text-gray-500">
                    build: {i.buildstamp ?? "ยังไม่ทราบ"}{i.hasPassword ? ` · ทดสอบตอนบันทึก ${date(i.createdAt)}` : ""}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {sel && !sel.hasPassword && (
        <div className={`${cardCls} p-3`}>
          {isAdmin ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-800 dark:text-neutral-100">instance นี้ยังไม่มีรหัส ใส่ MID user และรหัสผ่านเพื่อใช้งาน</p>
              <label className="block"><span className={labelCls}>MID user</span>
                <input className={inputCls} value={fixUser} onChange={(e) => setFixUser(e.target.value)} autoComplete="off" /></label>
              <label className="block"><span className={labelCls}>Password</span>
                <input className={inputCls} type="password" value={fixPass} onChange={(e) => setFixPass(e.target.value)} autoComplete="new-password" /></label>
              <button type="button" disabled={busy || !fixUser.trim() || !fixPass} onClick={() => void saveCreds(sel)} className="btn-primary px-4 py-2 text-sm font-medium">
                {busy ? "Saving…" : "Save Password"}
              </button>
              {(!fixUser.trim() || !fixPass) && !busy && <p className="text-xs text-gray-500">กรอก MID user และรหัสผ่านให้ครบก่อน</p>}
            </div>
          ) : (
            <p className="text-sm text-gray-800 dark:text-neutral-100">ให้ Admin ใส่รหัส MID user ในหน้า Instances</p>
          )}
        </div>
      )}

      {sel && sel.hasPassword && !sel.buildstamp && (
        <div className={`${cardCls} space-y-2 p-3`}>
          <p className="text-sm text-gray-800 dark:text-neutral-100">instance นี้ยังไม่ทราบ build ของ ServiceNow เลือกแพ็กเกจที่โหลดไว้แล้ว หรือพิมพ์ buildstamp</p>
          {packages.length > 0 && (
            <label className="block"><span className={labelCls}>Local Packages</span>
              <select className={inputCls} value={packages.some((p) => p.buildstamp === bs) ? bs : ""} onChange={(e) => onChange({ buildstamp: e.target.value })}>
                <option value="">— Select —</option>
                {packages.map((p) => <option key={p.buildstamp} value={p.buildstamp}>{p.buildstamp}</option>)}
              </select></label>
          )}
          <label className="block"><span className={labelCls}>Or Enter Buildstamp</span>
            <input className={`${inputCls} font-mono`} value={state.buildstamp} onChange={(e) => onChange({ buildstamp: e.target.value })} spellCheck={false}
              placeholder="e.g. washingtondc-12-08-2023__patch5-02-14-2024_02-23-2024_1115" /></label>
          {bs && !BUILDSTAMP_RE.test(bs) && <p className="text-xs text-red-600">รูปแบบ buildstamp ไม่ถูกต้อง</p>}
        </div>
      )}
      {sel && sel.hasPassword && sel.buildstamp && <p className="text-xs text-gray-600">จะติดตั้ง MID build: <span className="font-mono break-all">{sel.buildstamp}</span></p>}

      {!adding ? (
        <button type="button" onClick={startAdd} className={ghostBtnCls}>+ Add Instance</button>
      ) : (
        <form className={`${cardCls} space-y-2 p-3`} onSubmit={(e) => { e.preventDefault(); if (addReady && !busy) void saveNew() }}>
          <p className="text-sm font-medium text-gray-900 dark:text-neutral-100">Add Instance</p>
          <label className="block"><span className={labelCls}>Instance URL</span>
            <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxx.service-now.com" autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Display Name (Optional)</span>
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. DEV" /></label>
          <label className="block"><span className={labelCls}>MID user</span>
            <input className={inputCls} value={midUser} onChange={(e) => setMidUser(e.target.value)} autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Password</span>
            <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!addReady || busy} onClick={() => void testOnly()} className={ghostBtnCls}>Test Connection</button>
            <button type="submit" disabled={!addReady || busy} className="btn-primary px-4 py-2 text-sm font-medium">{busy ? "Testing…" : "Test and Save"}</button>
            <button type="button" disabled={busy} onClick={cancelAdd} className={ghostBtnCls}>Cancel</button>
          </div>
          {addReason && <p className="text-xs text-gray-500">{addReason}</p>}
        </form>
      )}
      {err && <ErrorNotice error={err} />}
      {info && <p role="status" className="rounded-lg bg-green-100 px-3 py-2 text-sm text-green-800">{info}</p>}
    </div>
  )
}
