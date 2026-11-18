import { safeHttpUrl } from "@/lib/ui/api"
import { formatBytes, formatUptime, statusView, type MidView } from "@/lib/ui/status-view"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-gray-500 sm:w-40">{label}</dt>
      <dd className="min-w-0 break-all text-gray-900">{children}</dd>
    </div>
  )
}

export function OverviewTab({ mid }: { mid: MidView }) {
  const sv = statusView(mid)
  const url = safeHttpUrl(mid.instanceUrl)
  const recordUrl = url && mid.midName ? `${url}/ecc_agent_list.do?sysparm_query=name=${encodeURIComponent(mid.midName)}` : null
  const running = mid.status.state === "running"
  return (
    <dl className="divide-y divide-gray-100">
      <Row label="Instance">
        {url ? <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">{url}</a> : (mid.instanceUrl ?? "-")}
      </Row>
      <Row label="ชื่อ MID ใน ServiceNow">{mid.midName ?? "-"}</Row>
      <Row label="เวอร์ชัน">{mid.version || "ไม่ทราบ"}</Row>
      <Row label="สถานะ service">{sv.icon} {sv.label}</Row>
      <Row label="Uptime">{running ? formatUptime(mid.status.since) : "-"}</Row>
      <Row label="RAM ที่ใช้">{formatBytes(mid.status.memoryBytes)}</Row>
      <Row label="Heap">{mid.heapMb} MB</Row>
      <Row label="Record ใน instance">
        {recordUrl
          ? <a href={recordUrl} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">เปิดดู MID Server ใน ServiceNow</a>
          : "-"}
      </Row>
    </dl>
  )
}
