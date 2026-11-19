import Link from "next/link"
import { usePathname } from "next/navigation"
import { AgentAccessSwitch } from "./AgentAccessSwitch"
import { safeHttpUrl } from "@/lib/ui/api"
import { instanceRecordUrl } from "@/lib/ui/record-link"
import { jobKindLabel, jobStatusLabel } from "@/lib/ui/stages"
import { formatBytes, formatJobTime, formatUptime, statusView, type MidView } from "@/lib/ui/status-view"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-gray-500 sm:w-40">{label}</dt>
      <dd className="min-w-0 break-all text-gray-900">{children}</dd>
    </div>
  )
}

type Props = {
  mid: MidView
  /** the panel already shows this job's progress */
  jobShown?: boolean
  /** why the AgentHub switch cannot change now (MidPanel's busyReason) */
  busyReason?: string | null
  onChanged?: () => void
}

export function OverviewTab({ mid, jobShown = false, busyReason = null, onChanged = () => {} }: Props) {
  const sv = statusView(mid)
  const pathname = usePathname()
  const url = safeHttpUrl(mid.instanceUrl)
  const recordUrl = instanceRecordUrl(mid.instanceUrl, mid.midName)
  const running = mid.status.state === "running"
  return (
    <dl className="divide-y divide-gray-100">
      <Row label="Instance">
        {url ? <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">{url}</a> : (mid.instanceUrl ?? "-")}
      </Row>
      <Row label="MID Server Name">{mid.midName ?? "-"}</Row>
      <Row label="Version">{mid.version || "Unknown"}</Row>
      <Row label="Service Status">{sv.icon} {sv.label}</Row>
      <Row label="Uptime">{running ? formatUptime(mid.status.since) : "-"}</Row>
      <Row label="Memory Usage">{formatBytes(mid.status.memoryBytes)}</Row>
      <Row label="Heap">{mid.heapMb} MB</Row>
      <Row label="AgentHub">
        <AgentAccessSwitch midName={mid.name} enabled={mid.agentAccess ?? false} disabledReason={busyReason} onChanged={onChanged} />
      </Row>
      <Row label="Instance Record">
        {recordUrl
          ? <a href={recordUrl} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">Open in ServiceNow</a>
          : "-"}
      </Row>
      {mid.job && (
        <Row label="Last Job">
          {jobKindLabel(mid.job.kind)} · {jobStatusLabel(mid.job.status)} · {formatJobTime(mid.job.createdAt)}{" "}
          {(mid.job.kind === "install" || mid.job.kind === "clone") && !jobShown && (
          <Link replace scroll={false} href={`${pathname}?mid=${encodeURIComponent(mid.name)}&job=${encodeURIComponent(mid.job.id)}`}
            className="whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400">View Progress</Link>)}
        </Row>
      )}
    </dl>
  )
}
