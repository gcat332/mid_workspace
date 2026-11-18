"use client"

import { Suspense, useEffect, useState, type FormEvent } from "react"
import { useSearchParams } from "next/navigation"
import { errorTextCls, inputCls, labelCls } from "@/lib/ui/classes"

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


export function LoginForm() {
  return (
    <Suspense>
      <LoginFormInner />
    </Suspense>
  )
}

function LoginFormInner() {
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
        // Own fetch on purpose (not apiFetch): a 401 here is a wrong password, not an expired session.
        setError(typeof data.message === "string" ? data.message : "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
        return
      }
      window.location.href = data.next ?? "/midhub"
    } catch {
      setError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-svh flex items-center justify-center bg-gray-50 dark:bg-neutral-900">
      <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-lg w-full max-w-sm mx-4 p-8">
        <div className="mb-6 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/midhub/logo-mfec-black.png" alt="MFEC" className="h-6 w-auto dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/midhub/logo-mfec-white.png" alt="MFEC" className="h-6 w-auto hidden dark:block" />
          <span className="h-5 w-px bg-gray-200 dark:bg-neutral-700" />
          <span className="text-xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500 bg-clip-text text-transparent">BSM</span> <span className="text-blue-600 dark:text-blue-400">MIDHub</span>
          </span>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-6">เข้าสู่ระบบ BSM MIDHub</h1>

        {error && <p role="alert" className={`mb-4 text-sm ${errorTextCls.replace("text-xs ", "")}`}>{error}</p>}

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-email" className={labelCls}>อีเมล</label>
            <input id="login-email" type="email" required autoComplete="username" value={email}
              onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="login-password" className={labelCls}>รหัสผ่าน</label>
            <input id="login-password" type="password" required autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} className={inputCls} />
          </div>
          <button type="submit" disabled={busy} className="w-full py-2 px-4 text-sm font-medium btn-primary">
            {busy ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
          </button>
        </form>

        {idp.enabled && (
          <>
            <div className="my-5 text-center text-xs text-gray-400">หรือ</div>
            <a href="/midhub/api/auth/oidc/start"
              className="w-full py-3 px-4 text-sm font-semibold rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700 transition-colors flex items-center justify-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/midhub/logo-mfec-black.png" alt="" className="h-5 w-auto dark:hidden" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/midhub/logo-mfec-white.png" alt="" className="h-5 w-auto hidden dark:block" />
              เข้าสู่ระบบด้วย {idp.label}
            </a>
          </>
        )}
      </div>
    </div>
  )
}
