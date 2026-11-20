"use client"

import { ghostBtnCls } from "@/lib/ui/classes"

type Props = {
  count: number
  /** Why Delete is off (a locked entry, a read-only folder, a running job); null when it is available. */
  deleteDisabledReason: string | null
  /** A request is in flight: every action is off. */
  busy: boolean
  onZip: () => void
  onDelete: () => void
  onClear: () => void
}

/** Bar at the bottom of the files card while two or more rows are selected. */
export function SelectionBar({ count, deleteDisabledReason, busy, onZip, onDelete, onClear }: Props) {
  return (
    <div role="toolbar" aria-label="Selection Actions" className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-blue-50 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-blue-950/40">
      <span className="font-medium text-blue-800 dark:text-blue-200">เลือก {count} รายการ</span>
      <div className="ml-auto flex items-center gap-2">
        {deleteDisabledReason && <span id="sel-delete-reason" className="text-xs text-gray-600 dark:text-neutral-400">{deleteDisabledReason}</span>}
        <button type="button" disabled={busy} className={ghostBtnCls} onClick={onZip}>Download .zip</button>
        <button type="button" disabled={busy || deleteDisabledReason !== null} aria-describedby={deleteDisabledReason ? "sel-delete-reason" : undefined}
          title={deleteDisabledReason ?? undefined} onClick={onDelete}
          className="rounded-[10px] border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40">Delete</button>
        <button type="button" className={ghostBtnCls} onClick={onClear}>Clear</button>
      </div>
    </div>
  )
}
