"use client"

import { useState } from "react"

export type ApiError = { code?: string; message: string; detail?: string }

/** Builds a displayable error from a failed fetch Response (never exposes anything but message/detail). */
export async function readApiError(res: Response): Promise<ApiError> {
  const j = (await res.json().catch(() => null)) as Partial<ApiError> | null
  if (j && typeof j.message === "string") {
    return { code: j.code, message: j.message, detail: typeof j.detail === "string" ? j.detail : undefined }
  }
  if (res.status === 401) return { code: "unauthorized", message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" }
  return { code: "unknown", message: "เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง", detail: `HTTP ${res.status}` }
}

export function ErrorNotice({ error }: { error: ApiError }) {
  const [open, setOpen] = useState(false)
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <p>{error.message}</p>
      {error.detail && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
            className="mt-1 text-xs text-red-700 underline">
            {open ? "Hide Details" : "Show Details"}
          </button>
          {open && (
            <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-white/70 dark:bg-black/30 p-2 font-mono text-xs text-red-900">
              {error.detail}
            </pre>
          )}
        </>
      )}
    </div>
  )
}
