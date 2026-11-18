"use client"

import { useEffect, useState } from "react"

type User = { id: string; email: string; role: "admin" | "member"; lockedAt: string | null; lastLoginAt: string | null }

const API = "/midhub/api/admin/users"
const input = "rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("th-TH") : "—")

async function failMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  if (j.error) return j.error
  return res.status === 401 || res.status === 403
    ? "ไม่มีสิทธิ์ดำเนินการ กรุณาเข้าสู่ระบบด้วยบัญชี Admin อีกครั้ง"
    : fallback
}
const NET = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่"

export function UsersManager({ myId }: { myId: string }) {
  const [users, setUsers] = useState<User[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<"admin" | "member">("member")
  const [password, setPassword] = useState("")
  const [pwTarget, setPwTarget] = useState<User | null>(null)
  const [newPw, setNewPw] = useState("")
  const [err, setErr] = useState("")
  const [reload, setReload] = useState(0)
  const load = () => setReload((n) => n + 1)

  useEffect(() => {
    fetch(API)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j: User[]) => setUsers(j))
      .catch(() => setErr("โหลดรายชื่อผู้ใช้ไม่สำเร็จ ตรวจสอบว่าเข้าสู่ระบบด้วยบัญชี Admin"))
  }, [reload])

  async function call(url: string, init: RequestInit, fallback: string): Promise<boolean> {
    setErr("")
    try {
      const res = await fetch(url, init)
      if (!res.ok) { setErr(await failMessage(res, fallback)); return false }
      load()
      return true
    } catch {
      setErr(NET)
      return false
    }
  }
  const json = (method: string, body: unknown): RequestInit =>
    ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  async function add() {
    const ok = await call(API, json("POST", { email, role, ...(password ? { password } : {}) }),
      "เพิ่มผู้ใช้ไม่สำเร็จ เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง")
    if (ok) { setEmail(""); setPassword(""); setRole("member") }
  }
  const patch = (u: User, body: unknown, fallback: string) => call(`${API}/${u.id}`, json("PATCH", body), fallback)

  async function submitPw() {
    if (!pwTarget) return
    if (newPw.length < 8) { setErr("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร"); return }
    const ok = await patch(pwTarget, { password: newPw }, "ตั้งรหัสผ่านไม่สำเร็จ เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง")
    if (ok) { setPwTarget(null); setNewPw("") }
  }
  async function changeRole(u: User, next: "admin" | "member") {
    if (!window.confirm(`เปลี่ยนสิทธิ์ ${u.email} เป็น ${next}?`)) return
    await patch(u, { role: next }, "เปลี่ยนสิทธิ์ไม่สำเร็จ เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง")
  }
  async function remove(u: User) {
    if (!window.confirm(`ลบผู้ใช้ ${u.email}? การลบไม่สามารถย้อนกลับได้`)) return
    await call(`${API}/${u.id}`, { method: "DELETE" }, "ลบผู้ใช้ไม่สำเร็จ เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง")
  }

  return (
    <section>
      <h1 className="text-xl font-semibold text-gray-900 mb-2">ผู้ใช้</h1>
      <p className="text-sm text-gray-600 mb-4">
        ถ้าไม่ใส่รหัสผ่าน ผู้ใช้จะเข้าสู่ระบบได้ด้วย SSO เท่านั้น (SSO ใช้ได้เฉพาะอีเมลที่ลงทะเบียนไว้ที่นี่)
      </p>
      <div className="flex flex-wrap gap-2 mb-3">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="อีเมล" aria-label="อีเมล"
          className={`${input} flex-1 min-w-[200px]`} />
        <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")} aria-label="สิทธิ์" className={input}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
          placeholder="รหัสผ่าน (ไม่บังคับ — เว้นว่าง = SSO เท่านั้น)" aria-label="รหัสผ่าน" className={`${input} flex-1 min-w-[200px]`} />
        <button onClick={() => void add()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">เพิ่ม</button>
      </div>
      {pwTarget && (
        <div className="flex flex-wrap items-center gap-2 mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <span className="text-sm text-gray-700">ตั้งรหัสผ่านใหม่ให้ {pwTarget.email}</span>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password"
            placeholder="อย่างน้อย 8 ตัวอักษร" aria-label="รหัสผ่านใหม่" className={`${input} flex-1 min-w-[180px]`} />
          <button onClick={() => void submitPw()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">บันทึก</button>
          <button onClick={() => { setPwTarget(null); setNewPw("") }} className="text-sm text-gray-600 hover:underline">ยกเลิก</button>
        </div>
      )}
      {err && <p role="alert" className="text-sm text-red-600 mb-2">{err}</p>}
      <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3">อีเมล</th><th className="px-4 py-3">สิทธิ์</th>
              <th className="px-4 py-3">สถานะ</th><th className="px-4 py-3">เข้าสู่ระบบล่าสุด</th><th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 text-gray-900">{u.email}{u.id === myId && <span className="text-gray-400"> (คุณ)</span>}</td>
                <td className="px-4 py-3 text-gray-700">{u.role}</td>
                <td className="px-4 py-3">
                  {u.lockedAt ? <span className="text-red-600">ถูกล็อก</span> : <span className="text-gray-500">ปกติ</span>}
                </td>
                <td className="px-4 py-3 text-gray-500">{fmt(u.lastLoginAt)}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                  {u.lockedAt && (
                    <button className="text-blue-600 hover:underline"
                      onClick={() => void patch(u, { unlock: true }, "ปลดล็อกไม่สำเร็จ เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง")}>ปลดล็อก</button>
                  )}
                  <button className="text-blue-600 hover:underline" onClick={() => { setPwTarget(u); setNewPw(""); setErr("") }}>ตั้งรหัสผ่าน</button>
                  {u.id !== myId && (
                    <>
                      <button className="text-blue-600 hover:underline"
                        onClick={() => void changeRole(u, u.role === "admin" ? "member" : "admin")}>
                        {u.role === "admin" ? "ลดเป็น member" : "เลื่อนเป็น admin"}
                      </button>
                      <button className="text-red-600 hover:underline" onClick={() => void remove(u)}>ลบ</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">ยังไม่มีผู้ใช้</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
