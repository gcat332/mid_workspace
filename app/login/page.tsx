"use client"

import { Suspense, useEffect, useState, type FormEvent } from "react"
import { useSearchParams } from "next/navigation"

// Only these codes (from the SSO routes) are ever shown; anything else gets the generic text.
const SSO_ERRORS: Record<string, string> = {
  not_registered: "บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้ MidHub กรุณาติดต่อ Admin",
  locked: "บัญชีถูกล็อก กรุณาติดต่อผู้ดูแลระบบเพื่อปลดล็อก",
  state: "เซสชัน SSO หมดอายุหรือไม่ถูกต้อง กรุณาลองเข้าสู่ระบบด้วย SSO ใหม่อีกครั้ง",
  disabled: "SSO ยังไม่เปิดใช้งาน กรุณาติดต่อ Admin",
  misconfigured: "SSO ตั้งค่าไม่ครบ กรุณาติดต่อ Admin",
  token: "แลกโทเคนกับ IdP ไม่สำเร็จ กรุณาติดต่อ Admin ให้ตรวจ client secret และ redirect URI",
  no_email: "ไม่พบอีเมลในโปรไฟล์ SSO กรุณาติดต่อ Admin",
}
const SSO_ERROR_FALLBACK = "เข้าสู่ระบบด้วย SSO ไม่สำเร็จ กรุณาลองใหม่อีกครั้งหรือติดต่อ Admin"


export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}

function LoginForm() {
  const errCode = useSearchParams().get("error")
  const [idp, setIdp] = useState<{ enabled: boolean; label: string }>({ enabled: false, label: "SSO" })
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(
    errCode ? (Object.hasOwn(SSO_ERRORS, errCode) ? SSO_ERRORS[errCode] : SSO_ERROR_FALLBACK) : null,
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // A failure simply means SSO is off.
    fetch("/midhub/api/auth/idp")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (s?.enabled) setIdp({ enabled: true, label: s.label ?? "SSO" }) })
      .catch(() => {})
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/midhub/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
        return
      }
      window.location.href = data.next ?? "/midhub"
    } catch {
      setError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่")
    } finally {
      setBusy(false)
    }
  }

  const input = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-sm mx-4 p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-6">เข้าสู่ระบบ MidHub</h1>

        {error && <p role="alert" className="mb-4 text-sm text-red-600">{error}</p>}

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm text-gray-700">
            อีเมล
            <input type="email" required autoComplete="username" value={email}
              onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <label className="block text-sm text-gray-700">
            รหัสผ่าน
            <input type="password" required autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <button type="submit" disabled={busy}
            className="w-full py-2.5 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {busy ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
          </button>
        </form>

        {idp.enabled && (
          <>
            <div className="my-5 text-center text-xs text-gray-400">หรือ</div>
            <a href="/midhub/api/auth/oidc/start"
              className="block w-full py-2.5 text-center text-sm font-semibold rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 transition-colors">
              เข้าสู่ระบบด้วย SSO
            </a>
          </>
        )}
      </div>
    </div>
  )
}
