"use client"

import { useEffect, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { isLocked } from "@/lib/auth/lockout"

type Role = "admin" | "member"
type User = { id: string; email: string; role: Role; lockedAt: string | null; lastLoginAt: string | null }
type Pending = { title: string; body: string; confirmLabel: string; danger?: boolean; run: () => Promise<boolean> }

const ROLE_TH: Record<Role, string> = { admin: "ผู้ดูแลระบบ", member: "สมาชิก" }
const input = "rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("th-TH") : "—")
const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }

export function UsersManager({ myId }: { myId: string }) {
  const [users, setUsers] = useState<User[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("member")
  const [password, setPassword] = useState("")
  const [pwTarget, setPwTarget] = useState<User | null>(null)
  const [newPw, setNewPw] = useState("")
  const [err, setErr] = useState<ApiError | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const load = () => setReload((n) => n + 1)

  useEffect(() => {
    apiFetch("/admin/users")
      .then(async (r) => (r.ok ? setUsers((await r.json()) as User[]) : setErr(await readApiError(r))))
      .catch(() => setErr(NET))
  }, [reload])

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setErr(null); setBusy(true)
    try {
      const res = await apiFetch(path, init)
      if (!res.ok) { setErr(await readApiError(res)); return false }
      load()
      return true
    } catch {
      setErr(NET)
      return false
    } finally {
      setBusy(false)
    }
  }
  const json = (method: string, body: unknown): RequestInit =>
    ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  async function add() {
    const ok = await call("/admin/users", json("POST", { email, role, ...(password ? { password } : {}) }))
    if (ok) { setEmail(""); setPassword(""); setRole("member") }
  }
  const patch = (u: User, body: unknown) => call(`/admin/users/${encodeURIComponent(u.id)}`, json("PATCH", body))

  async function submitPw() {
    if (!pwTarget) return
    if (newPw.length < 8) { setErr({ message: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร" }); return }
    if (await patch(pwTarget, { password: newPw })) { setPwTarget(null); setNewPw("") }
  }
  function changeRole(u: User, next: Role) {
    setPending({
      title: `เปลี่ยนสิทธิ์ ${u.email}?`,
      body: `จาก${ROLE_TH[u.role]} เป็น${ROLE_TH[next]}`,
      confirmLabel: "เปลี่ยนสิทธิ์",
      danger: next === "member",
      run: () => patch(u, { role: next }),
    })
  }
  function remove(u: User) {
    setPending({
      title: `ลบผู้ใช้ ${u.email}?`,
      body: "ผู้ใช้นี้จะเข้าสู่ระบบไม่ได้อีก การลบไม่สามารถย้อนกลับได้",
      confirmLabel: "ลบผู้ใช้",
      danger: true,
      run: () => call(`/admin/users/${encodeURIComponent(u.id)}`, { method: "DELETE" }),
    })
  }

  return (
    <section>
      <h1 className="mb-2 text-xl font-semibold text-gray-900">ผู้ใช้</h1>
      <p className="mb-4 text-sm text-gray-600">
        ถ้าไม่ใส่รหัสผ่าน ผู้ใช้จะเข้าสู่ระบบได้ด้วย SSO เท่านั้น (SSO ใช้ได้เฉพาะอีเมลที่ลงทะเบียนไว้ที่นี่)
      </p>
      <form className="mb-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="อีเมล" aria-label="อีเมล"
          className={`${input} min-w-[200px] flex-1`} />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="สิทธิ์" className={input}>
          <option value="member">{ROLE_TH.member}</option>
          <option value="admin">{ROLE_TH.admin}</option>
        </select>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
          placeholder="รหัสผ่าน (ว่าง = SSO เท่านั้น)" aria-label="รหัสผ่าน (ไม่บังคับ — เว้นว่าง = SSO เท่านั้น)"
          className={`${input} min-w-[220px] flex-1`} />
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">เพิ่ม</button>
      </form>
      {pwTarget && (
        <form className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
          onSubmit={(e) => { e.preventDefault(); void submitPw() }}>
          <span className="text-sm text-gray-700">ตั้งรหัสผ่านใหม่ให้ {pwTarget.email}</span>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password"
            placeholder="อย่างน้อย 8 ตัวอักษร" aria-label="รหัสผ่านใหม่" className={`${input} min-w-[180px] flex-1`} />
          <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">บันทึก</button>
          <button type="button" onClick={() => { setPwTarget(null); setNewPw("") }} className="text-sm text-gray-600 hover:underline">ยกเลิก</button>
        </form>
      )}
      {err && <div className="mb-2"><ErrorNotice error={err} /></div>}
      <div className="relative overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3">อีเมล</th><th className="px-4 py-3">สิทธิ์</th>
              <th className="px-4 py-3">สถานะ</th><th className="px-4 py-3">เข้าสู่ระบบล่าสุด</th><th className="px-4 py-3"><span className="sr-only">จัดการ</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => {
              const locked = isLocked(u.lockedAt)
              return (
                <tr key={u.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-900">{u.email}{u.id === myId && <span className="text-gray-400"> (คุณ)</span>}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-700">{ROLE_TH[u.role] ?? u.role}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {locked ? <span className="text-red-600">ถูกล็อก (ปลดเองใน 15 นาที)</span> : <span className="text-gray-500">ปกติ</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">{fmt(u.lastLoginAt)}</td>
                  <td className="space-x-3 whitespace-nowrap px-4 py-3 text-right">
                    {locked && (
                      <button type="button" disabled={busy} className="text-blue-600 hover:underline" onClick={() => void patch(u, { unlock: true })}>ปลดล็อก</button>
                    )}
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => { setPwTarget(u); setNewPw(""); setErr(null) }}>ตั้งรหัสผ่าน</button>
                    {u.id !== myId && (
                      <>
                        <button type="button" className="text-blue-600 hover:underline"
                          onClick={() => changeRole(u, u.role === "admin" ? "member" : "admin")}>
                          {u.role === "admin" ? `ลดเป็น${ROLE_TH.member}` : `เลื่อนเป็น${ROLE_TH.admin}`}
                        </button>
                        <button type="button" className="text-red-600 hover:underline" onClick={() => remove(u)}>ลบ</button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">ยังไม่มีผู้ใช้</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pending && (
        <ConfirmDialog title={pending.title} confirmLabel={pending.confirmLabel} danger={pending.danger} busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void pending.run().then(() => setPending(null))}>
          {pending.body}
        </ConfirmDialog>
      )}
    </section>
  )
}
