"use client"

import type { ReactNode } from "react"
import { Modal } from "./Modal"
import { ghostBtnCls } from "@/lib/ui/classes"

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
      <h2 id="confirm-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-100">{title}</h2>
      <div className="mt-2 text-sm text-gray-700">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button data-autofocus type="button" onClick={onCancel} disabled={busy}
          className={ghostBtnCls}>
          ยกเลิก
        </button>
        <button type="button" onClick={onConfirm} disabled={busy}
          className={danger ? "rounded-[10px] bg-danger px-4 py-2 text-sm font-semibold text-white hover:bg-danger-press disabled:opacity-50" : "btn-primary px-4 py-2 text-sm font-medium"}>
          {busy ? "กำลังดำเนินการ..." : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
