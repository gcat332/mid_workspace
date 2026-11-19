import { redirect } from "next/navigation"
import { getSessionUser, sessionLocked } from "@/lib/auth/helpers"
import { BASE_PATH } from "@/lib/ui/api"

export const dynamic = "force-dynamic"

// The access page (no local login: sign-in is through AgentHub, admins only). The proxy never gates or
// re-verifies this path and nothing here redirects into the gate, so it cannot loop. Only a session the DB
// still accepts is sent on to the app.
const REASONS: Record<string, { title: string; body: string }> = {
  signed_out: {
    title: "Signed Out of AgentHub",
    body: "MidHub ใช้บัญชีเดียวกับ AgentHub คุณยังไม่ได้เข้าสู่ระบบ AgentHub หรือเซสชันของ AgentHub หมดอายุแล้ว",
  },
  not_admin: {
    title: "Not an AgentHub Admin",
    body: "MidHub เปิดให้ใช้เฉพาะ admin ของ AgentHub บัญชี AgentHub ที่เข้าสู่ระบบอยู่ไม่ใช่ admin หากต้องใช้ MidHub ให้ติดต่อ admin ของ AgentHub",
  },
  unreachable: {
    title: "AgentHub Unreachable",
    body: "MidHub ยืนยันตัวตนผ่าน AgentHub แต่ตอนนี้ติดต่อ AgentHub ไม่ได้ จึงเข้า MidHub ไม่ได้ชั่วคราว ลองใหม่อีกสักครู่ หากยังไม่ได้ให้แจ้งผู้ดูแลเซิร์ฟเวอร์",
  },
  locked: {
    title: "Account Locked",
    body: "บัญชีของคุณถูกล็อกไม่ให้เข้า MidHub (แม้ยังเป็น admin ของ AgentHub) กรุณาติดต่อ admin ของ MidHub ให้ปลดล็อก",
  },
  logged_out: {
    title: "Signed Out of MidHub",
    body: "ออกจากระบบ MidHub แล้ว (ไม่ได้ออกจากระบบ AgentHub) เมื่อต้องการใช้งานอีกครั้ง กดเข้า MidHub อีกครั้งด้านล่าง",
  },
}
const GENERIC = {
  title: "Sign In with AgentHub",
  body: "MidHub ใช้ได้เฉพาะ admin ของ AgentHub และเข้าสู่ระบบผ่าน AgentHub เท่านั้น",
}

type Props = { searchParams: Promise<{ reason?: string | string[] }> }

export default async function LoginPage({ searchParams }: Props) {
  if (await getSessionUser()) redirect("/")
  const raw = (await searchParams).reason
  const reason = (Array.isArray(raw) ? raw[0] : raw) ?? ((await sessionLocked()) ? "locked" : undefined)
  const text = reason && Object.hasOwn(REASONS, reason) ? REASONS[reason] : GENERIC

  return (
    <div className="min-h-svh flex items-center justify-center bg-gray-50 dark:bg-neutral-900">
      <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-lg w-full max-w-md mx-4 p-8">
        <div className="mb-6 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/logo-mfec-black.png`} alt="MFEC" className="h-6 w-auto dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/logo-mfec-white.png`} alt="MFEC" className="h-6 w-auto hidden dark:block" />
          <span className="h-5 w-px bg-gray-200 dark:bg-neutral-700" />
          <span className="text-xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500 bg-clip-text text-transparent">BSM</span> <span className="text-blue-600 dark:text-blue-400">MIDHub</span>
          </span>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-3">{text.title}</h1>
        <p role={reason && reason !== "logged_out" ? "alert" : undefined} className="mb-6 text-sm text-gray-600 dark:text-neutral-300">{text.body}</p>

        {/* AgentHub's own login page on this same site: an absolute path, deliberately outside basePath. */}
        <a href="/login" className="w-full py-2 px-4 text-sm font-medium btn-primary flex items-center justify-center">
          Sign In with AgentHub
        </a>
        <p className="mt-3 text-xs text-gray-500 dark:text-neutral-400">
          เข้าสู่ระบบ AgentHub ด้วยบัญชี admin แล้วกลับมาที่ /midhub
        </p>
        <div className="mt-5 border-t border-gray-100 dark:border-neutral-700 pt-4 text-center">
          <a href={`${BASE_PATH}/api/auth/agenthub`} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            เข้าสู่ระบบ AgentHub แล้ว? เข้า MidHub อีกครั้ง
          </a>
        </div>
      </div>
    </div>
  )
}
