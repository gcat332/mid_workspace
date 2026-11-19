"use client"

import { useEffect, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { apiFetch } from "@/lib/ui/api"
import { isLocked } from "@/lib/auth/lockout"

// Read-only list of who has signed in (AgentHub admins, created on first sign-in). The only action is lock/unlock:
// a lock keeps that person out of MidHub even while AgentHub still says admin.
type User = { id: string; email: string; lockedAt: string | null; lastLoginAt: string | null }
type Pending = { user: User; lock: boolean }

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("th-TH") : "—")
const NET: ApiError = { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" }

export function UsersManager({ myId }: { myId: string }) {
  const [users, setUsers] = useState<User[]>([])
  const [err, setErr] = useState<ApiError | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    apiFetch("/admin/users")
      .then(async (r) => (r.ok ? setUsers((await r.json()) as User[]) : setErr(await readApiError(r))))
      .catch(() => setErr(NET))
  }, [reload])

  async function apply({ user, lock }: Pending) {
    setErr(null); setBusy(true)
    try {
      const res = await apiFetch(`/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lock ? { lock: true } : { unlock: true }),
      })
      if (!res.ok) setErr(await readApiError(res))
      else setReload((n) => n + 1)
    } catch {
      setErr(NET)
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  return (
    <section>
      <h1 className="mb-2 text-xl font-semibold text-gray-900">ผู้ใช้</h1>
      <p className="mb-4 text-sm text-gray-600">
        MidHub ใช้ได้เฉพาะ admin ของ AgentHub โดยเข้าสู่ระบบผ่าน AgentHub รายชื่อนี้คือผู้ที่เคยเข้า MidHub แล้ว
        จัดการบัญชีและสิทธิ์ได้ที่ AgentHub ส่วนที่นี่ทำได้เพียงล็อกไม่ให้เข้า MidHub
      </p>
      {err && <div className="mb-2"><ErrorNotice error={err} /></div>}
      <div className="relative overflow-x-auto rounded-xl border border-gray-200 bg-white dark:bg-neutral-800">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3">อีเมล</th><th className="px-4 py-3">สถานะ</th>
              <th className="px-4 py-3">เข้าใช้ล่าสุด</th><th className="px-4 py-3"><span className="sr-only">จัดการ</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => {
              const locked = isLocked(u.lockedAt)
              const self = u.id === myId
              return (
                <tr key={u.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-900">{u.email}{self && <span className="text-gray-400"> (คุณ)</span>}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {locked ? <span className="text-red-600">ถูกล็อก</span> : <span className="text-gray-500">ปกติ</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">{fmt(u.lastLoginAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {locked ? (
                      <button type="button" disabled={busy} className="text-blue-600 dark:text-blue-400 hover:underline"
                        onClick={() => setPending({ user: u, lock: false })}>ปลดล็อก</button>
                    ) : self ? (
                      <span className="text-xs text-gray-400">ล็อกบัญชีตัวเองไม่ได้</span>
                    ) : (
                      <button type="button" disabled={busy} className="text-red-600 hover:underline"
                        onClick={() => setPending({ user: u, lock: true })}>ล็อก</button>
                    )}
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">ยังไม่มีผู้ใช้</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pending && (
        <ConfirmDialog
          title={pending.lock ? `ล็อก ${pending.user.email}?` : `ปลดล็อก ${pending.user.email}?`}
          confirmLabel={pending.lock ? "ล็อก" : "ปลดล็อก"}
          danger={pending.lock} busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply(pending)}>
          {pending.lock
            ? "ผู้ใช้นี้จะเข้า MidHub ไม่ได้ทันที (แม้ยังเป็น admin ของ AgentHub) จนกว่าจะมี admin มาปลดล็อก"
            : "ผู้ใช้นี้จะเข้า MidHub ได้อีกครั้ง ถ้ายังเป็น admin ของ AgentHub"}
        </ConfirmDialog>
      )}
    </section>
  )
}
