"use client"

import type { ReactNode } from "react"
import { Modal } from "./Modal"

type Props = {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, children, confirmLabel, danger, busy, onConfirm, onCancel }: Props) {
  return (
    <Modal labelledBy="confirm-title" onClose={onCancel} busy={busy}>
      <h2 id="confirm-title" className="text-lg font-semibold text-gray-900">{title}</h2>
      <div className="mt-2 text-sm text-gray-700">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button data-autofocus type="button" onClick={onCancel} disabled={busy}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          ยกเลิก
        </button>
        <button type="button" onClick={onConfirm} disabled={busy}
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}`}>
          {busy ? "กำลังดำเนินการ..." : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
