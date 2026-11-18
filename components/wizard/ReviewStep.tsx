"use client"

import { cardCls } from "@/lib/ui/classes"
import { effectiveBuildstamp, type Check, type WizardState } from "@/lib/ui/wizard"
import type { ExtraDraft } from "./SettingsStep"

type Props = { state: WizardState; extra: ExtraDraft; instanceLabel: string; checks: Check[]; hostLoading: boolean }

const ICON = { ok: "✓", warn: "⚠", block: "✗" } as const
const TONE = { ok: "text-emerald-700", warn: "text-amber-800", block: "text-red-700" } as const

export function ReviewStep({ state, extra, instanceLabel, checks, hostLoading }: Props) {
  const rows: [string, string][] = [
    ["Instance", instanceLabel],
    ["Build", effectiveBuildstamp(state)],
    ["ชื่อ MID", state.name],
    ["ชื่อใน ServiceNow", state.snName],
    ["Clone จาก", extra.cloneFrom || "ไม่ clone"],
    ["Heap", `${state.heapMb} MB`],
    ["ไฟล์ log", state.logFiles],
    ["Proxy", state.proxyOn ? `${state.proxyHost}:${state.proxyPort}` : "ไม่ใช้"],
  ]
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-neutral-100">ตรวจสอบก่อนติดตั้ง</h3>
        <p className="mt-0.5 text-sm text-gray-600">ตรวจสอบรายการแล้วกด “ติดตั้ง” ใช้เวลาประมาณไม่กี่นาที</p>
      </div>
      <dl className={`${cardCls} divide-y divide-gray-200 text-sm dark:divide-neutral-700`}>
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 px-3 py-2">
            <dt className="text-gray-600">{k}</dt>
            <dd className="break-all font-medium text-gray-900 dark:text-neutral-100">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1 text-sm font-medium text-gray-900 dark:text-neutral-100">ตรวจความพร้อมของเครื่อง</p>
        {hostLoading ? <p className="text-sm text-gray-500">กำลังตรวจสอบ...</p> : (
          <ul className="space-y-1.5" aria-label="ผลตรวจสอบ">
            {checks.map((c, i) => (
              <li key={i} className={`flex gap-2 text-sm ${TONE[c.level]}`}>
                <span aria-hidden className="w-4 shrink-0 text-center font-bold">{ICON[c.level]}</span>
                <span className="sr-only">{c.level === "ok" ? "ผ่าน" : c.level === "warn" ? "คำเตือน" : "ไม่ผ่าน"}:</span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
