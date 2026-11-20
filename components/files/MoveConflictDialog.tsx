"use client"

import { useState } from "react"
import { Modal } from "../Modal"
import { ghostBtnCls } from "@/lib/ui/classes"

type Props = {
  name: string
  onReplace: (all: boolean) => void
  onSkip: (all: boolean) => void
  onCancel: () => void
}

/** A moved file meets a same-named file at the destination: replace it, skip it, or stop the whole move. */
export function MoveConflictDialog({ name, onReplace, onSkip, onCancel }: Props) {
  const [all, setAll] = useState(false)
  return (
    <Modal labelledBy="move-conflict-title" onClose={onCancel}>
      <h2 id="move-conflict-title" className="break-all text-lg font-semibold text-gray-900 dark:text-neutral-100">Replace {name}?</h2>
      <p className="mt-2 text-sm text-gray-700 dark:text-neutral-300">ปลายทางมีไฟล์ชื่อนี้อยู่แล้ว ไฟล์เดิมจะถูกแทนที่ กู้คืนไม่ได้</p>
      <label className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-neutral-300">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        ใช้กับไฟล์ที่ชื่อซ้ำทั้งหมดในการย้ายครั้งนี้
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button data-autofocus type="button" onClick={onCancel} className={ghostBtnCls}>Cancel</button>
        <button type="button" onClick={() => onSkip(all)} className={ghostBtnCls}>Skip</button>
        <button type="button" onClick={() => onReplace(all)}
          className="rounded-[10px] bg-danger px-4 py-2 text-sm font-semibold text-white hover:bg-danger-press">Replace</button>
      </div>
    </Modal>
  )
}
