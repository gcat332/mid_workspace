import Link from "next/link"
import { usePathname } from "next/navigation"
import { AgentAccessSwitch } from "./AgentAccessSwitch"
import { safeHttpUrl } from "@/lib/ui/api"
import { instanceRecordUrl } from "@/lib/ui/record-link"
import { jobKindLabel, jobStatusLabel } from "@/lib/ui/stages"
import { formatBytes, formatJobTime, formatUptime, type MidView } from "@/lib/ui/status-view"

function Row({ label, mono = false, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-gray-100 py-2.5 last:border-b-0 sm:grid sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-0">
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd className={`min-w-0 break-all text-sm text-gray-900 ${mono ? "font-mono text-[13px]" : ""}`}>{children}</dd>
    </div>
  )
}

function Tile({ label, mono = false, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div data-testid="overview-tile" className="min-w-0 rounded-[10px] border border-gray-200 bg-gray-50 px-3.5 py-3">
      <div data-tile-label className="text-xs font-medium text-gray-600">{label}</div>
      <div className={`mt-0.5 font-semibold text-gray-900 ${mono ? "break-all font-mono text-[13px]" : "text-sm"}`}>{children}</div>
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
  const pathname = usePathname()
  const url = safeHttpUrl(mid.instanceUrl)
  const recordUrl = instanceRecordUrl(mid.instanceUrl, mid.midName)
  const running = mid.status.state === "running"
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Uptime">{running ? formatUptime(mid.status.since) : "-"}</Tile>
        <Tile label="Memory Usage">
          {formatBytes(mid.status.memoryBytes)} <span className="font-normal text-gray-600">of {mid.heapMb} MB heap</span>
        </Tile>
        <Tile label="Version" mono>{mid.version || "Unknown"}</Tile>
        <div data-testid="overview-tile" className="min-w-0 rounded-[10px] border border-gray-200 bg-gray-50 px-3.5 py-3">
          <div data-tile-label className="mb-1.5 text-xs font-medium text-gray-600">AgentHub Access</div>
          <AgentAccessSwitch midName={mid.name} enabled={mid.agentAccess ?? false} disabledReason={busyReason} onChanged={onChanged} />
        </div>
      </div>
      <dl>
        <Row label="Instance" mono>
          {url ? <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">{url}</a> : (mid.instanceUrl ?? "-")}
        </Row>
        <Row label="MID Server Name" mono>{mid.midName ?? "-"}</Row>
        {/* systemd unit name; same convention as lib/mids/names unitName (that module is server-only) */}
        <Row label="Service" mono>{`midhub-mid-${mid.name}.service`}</Row>
        <Row label="Instance Record">
          {recordUrl
            ? <a href={recordUrl} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">Open in ServiceNow ↗</a>
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
    </div>
  )
}
