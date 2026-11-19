import { StatusDot } from "@/components/StatusPill"
import { failedJobShown, jobIsActive, statusView, type MidView } from "@/lib/ui/status-view"

type Props = { mids: MidView[]; selected: string | null; onSelect: (name: string) => void }

/** "https://dev.service-now.com/x" -> "dev.service-now.com" (the list shows the host only). */
function hostOnly(url: string): string {
  try { return new URL(url).host }
  catch { return url.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "") }
}

export function MidList({ mids, selected, onSelect }: Props) {
  return (
    <div>
      <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-gray-600">MID Servers · {mids.length}</div>
      <ul aria-label="MID List" className="space-y-0.5">
        {mids.map((m) => {
          const sv = statusView(m)
          const active = m.name === selected
          const jobNote = jobIsActive(m) || failedJobShown(m)
          return (
            <li key={m.name}>
              <button type="button" onClick={() => onSelect(m.name)} aria-current={active ? "true" : undefined}
                className={`w-full rounded-lg px-2.5 py-2 text-left ${active ? "bg-blue-50" : "hover:bg-gray-50"}`}>
                <span className="flex items-center gap-2 text-[13px]">
                  <StatusDot tone={sv.tone} />
                  <span className={`truncate font-mono ${active ? "font-semibold text-brand-navy dark:text-blue-300" : "font-medium text-gray-900"}`}>{m.name}</span>
                  {m.agentAccess && (
                    <span className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">AgentHub</span>
                  )}
                  <span className={jobNote ? "shrink-0 text-xs font-normal text-gray-600" : "sr-only"}>{sv.label}</span>
                </span>
                <span className="mt-0.5 block truncate pl-3.5 text-xs text-gray-600">{m.instanceUrl ? hostOnly(m.instanceUrl) : "No Instance"}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
