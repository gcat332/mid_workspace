import type { StatusView } from "@/lib/ui/status-view"

type Tone = StatusView["tone"]

const PILL: Record<Tone, string> = {
  running: "bg-blue-50 text-blue-700",
  busy: "bg-blue-50 text-blue-700",
  stopped: "bg-gray-100 text-gray-600",
  unknown: "bg-gray-100 text-gray-600",
  failed: "bg-red-50 text-red-700",
}

const DOT: Record<Tone, string> = {
  running: "bg-[#2F5FA6] dark:bg-blue-300",
  busy: "bg-[#2F5FA6] dark:bg-blue-300 motion-safe:animate-pulse",
  stopped: "bg-gray-500",
  unknown: "border border-gray-400 bg-transparent",
  failed: "bg-red-600",
}

/** The status dot alone (the label lives elsewhere). */
export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden data-tone={tone} className={`inline-block size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
}

export function StatusPill({ view }: { view: StatusView }) {
  return (
    <span data-tone={view.tone} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL[view.tone]}`}>
      <StatusDot tone={view.tone} />
      {view.label}
    </span>
  )
}
