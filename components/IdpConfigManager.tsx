"use client"

import { useEffect, useState } from "react"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { inputCls } from "@/lib/ui/classes"

interface IdpForm {
  provider: string
  label: string
  enabled: boolean
  issuer: string
  clientId: string
  clientSecret: string
  tenantId: string
  redirectUri: string
  scopes: string
}

const EMPTY: IdpForm = {
  provider: "oidc", label: "SSO", enabled: false, issuer: "", clientId: "",
  clientSecret: "", tenantId: "", redirectUri: "", scopes: "openid profile email",
}

const input = inputCls
const labelCls = "block text-sm text-gray-700 mb-1"

export function IdpConfigManager() {
  const [form, setForm] = useState<IdpForm>(EMPTY)
  const [origin, setOrigin] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)

  useEffect(() => {
    apiFetch("/admin/idp")
      .then(async (r) => {
        if (!r.ok) { setErr(await readApiError(r)); return }
        setOrigin(window.location.origin)
        setForm({ ...EMPTY, ...((await r.json()) as Partial<IdpForm>) })
      })
      .catch(() => setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }))
  }, [])

  const set = <K extends keyof IdpForm>(k: K, v: IdpForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false) }

  const save = async () => {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const res = await apiFetch("/admin/idp", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      })
      if (!res.ok) { setErr(await readApiError(res)); return }
      if (form.clientSecret) setForm((f) => ({ ...f, clientSecret: "••••" }))
      setSaved(true)
    } catch {
      setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally { setSaving(false) }
  }
  const callback = `${origin}/midhub/api/auth/oidc/callback`

  return (
    <section>
      <h1 className="text-xl font-semibold text-gray-900 mb-2">SSO / Identity Provider</h1>
      <p className="text-sm text-gray-600 mb-4">
        เฉพาะอีเมลที่ลงทะเบียนใน MidHub แล้วเท่านั้นที่เข้าสู่ระบบด้วย SSO ได้
      </p>
      <div className="rounded-xl border border-gray-200 bg-white dark:bg-neutral-800 p-5 space-y-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          เปิดใช้งาน (แสดงปุ่ม SSO ในหน้าเข้าสู่ระบบ)
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="idp-label" className={labelCls}>ข้อความบนปุ่ม</label>
            <input id="idp-label" value={form.label} onChange={(e) => set("label", e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="idp-provider" className={labelCls}>Provider</label>
            <select id="idp-provider" value={form.provider} onChange={(e) => set("provider", e.target.value)} className={input}>
              <option value="oidc">Generic OIDC</option>
              <option value="azure-ad">Azure AD / Entra ID</option>
              <option value="google">Google</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="idp-issuer" className={labelCls}>Issuer URL</label>
            <input id="idp-issuer" value={form.issuer} onChange={(e) => set("issuer", e.target.value)} className={input} />
          </div>
          {form.provider === "azure-ad" && (
            <div>
              <label htmlFor="idp-tenant" className={labelCls}>Tenant ID</label>
              <input id="idp-tenant" value={form.tenantId} onChange={(e) => set("tenantId", e.target.value)} className={input} />
            </div>
          )}
          <div>
            <label htmlFor="idp-client-id" className={labelCls}>Client ID</label>
            <input id="idp-client-id" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="idp-secret" className={labelCls}>Client Secret</label>
            <input id="idp-secret" type="password" autoComplete="new-password" value={form.clientSecret}
              onChange={(e) => set("clientSecret", e.target.value)} className={input} />
            <p className="mt-1 text-xs text-gray-500">&quot;••••&quot; = ไม่เปลี่ยนค่าเดิม</p>
          </div>
          <div>
            <label htmlFor="idp-redirect" className={labelCls}>Redirect URI</label>
            <input id="idp-redirect" value={form.redirectUri} onChange={(e) => set("redirectUri", e.target.value)}
              placeholder={callback} className={input} />
            <p className="mt-1 break-all text-xs text-gray-500">
              ลงทะเบียนที่ IdP: <code>{callback}</code>
            </p>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="idp-scopes" className={labelCls}>Scopes</label>
            <input id="idp-scopes" value={form.scopes} onChange={(e) => set("scopes", e.target.value)} className={input} />
          </div>
        </div>
        <p className="text-xs text-gray-500">เปิดใช้งานได้เมื่อกรอก Issuer URL (https://), Client ID และ Client Secret ครบ</p>
        {err && <ErrorNotice error={err} />}
        <div className="flex items-center justify-end gap-3">
          {saved && <span role="status" className="text-sm text-emerald-600">บันทึกแล้ว</span>}
          <button onClick={() => void save()} disabled={saving}
            className="btn-primary px-4 py-2 text-sm font-medium">
            {saving ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        </div>
      </div>
    </section>
  )
}
