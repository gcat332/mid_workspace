import { failedJobShown, jobIsActive, statusView, type MidView } from "@/lib/ui/status-view"

type Props = { mids: MidView[]; selected: string | null; onSelect: (name: string) => void }

export function MidList({ mids, selected, onSelect }: Props) {
  return (
    <ul aria-label="รายการ MID" className="space-y-1">
      {mids.map((m) => {
        const sv = statusView(m)
        const active = m.name === selected
        const jobNote = jobIsActive(m) || failedJobShown(m)
        return (
          <li key={m.name}>
            <button type="button" onClick={() => onSelect(m.name)} aria-current={active ? "true" : undefined}
              className={`w-full rounded-lg px-3 py-2 text-left ${active ? "bg-blue-50 ring-1 ring-blue-300" : "hover:bg-gray-50"}`}>
              <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
                <span aria-hidden>{sv.icon}</span>
                <span className="truncate">{m.name}</span>
                {m.agentAccess && (
                  <span className="shrink-0 rounded-full bg-brand-sky/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-navy ring-1 ring-brand-sky/40 dark:text-brand-sky-soft">AgentHub</span>
                )}
                <span className={jobNote ? "shrink-0 text-xs font-normal text-gray-600" : "sr-only"}>{sv.label}</span>
              </span>
              <span className="mt-0.5 block truncate pl-6 text-xs text-gray-500">{m.instanceUrl ?? "ไม่ระบุ instance"}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
