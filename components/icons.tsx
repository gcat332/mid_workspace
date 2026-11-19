// Inline SVG icons (no icon library). Line icons use currentColor so they follow text colour and dark mode;
// file-type icons carry their own colour, in the spirit of AgentHub's VS Code–style explorer icons.

type P = { className?: string }
const line = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const
const ICON = "h-4 w-4 shrink-0"

function Line({ className = ICON, children }: P & { children: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...line}>{children}</svg>
}

export const IconUpload = (p: P) => <Line {...p}><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></Line>
export const IconDownload = (p: P) => <Line {...p}><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></Line>
export const IconFilePlus = (p: P) => <Line {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 12v6M9 15h6" /></Line>
export const IconFolderPlus = (p: P) => <Line {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" /></Line>
export const IconRefresh = (p: P) => <Line {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Line>
export const IconSave = (p: P) => <Line {...p}><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8M7 21v-7h10v7" /></Line>
export const IconClose = (p: P) => <Line {...p}><path d="M6 6l12 12M18 6L6 18" /></Line>
export const IconMore = ({ className = ICON }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
)

export function FolderIcon({ open, className = ICON }: P & { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {open
        ? <><path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v1H2z" fill="#c09553" /><path d="M2.6 10h19.8l-2 9a1.5 1.5 0 0 1-1.5 1H4a1.5 1.5 0 0 1-1.5-1.2z" fill="#dcb67a" /></>
        : <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill="#dcb67a" />}
    </svg>
  )
}

type Kind = "xml" | "config" | "jar" | "log" | "file"
const KIND_BY_EXT: Record<string, Kind> = {
  xml: "xml", xsd: "xml",
  properties: "config", conf: "config", cfg: "config", ini: "config", yaml: "config", yml: "config", json: "config",
  jar: "jar", war: "jar", zip: "jar",
  log: "log", out: "log",
}
/** Icon kind for a file name (by extension; anything unknown is a generic file). */
export function fileKind(name: string): Kind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf(".")
  return (dot > 0 && KIND_BY_EXT[lower.slice(dot + 1)]) || "file"
}

const SHEET = "M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"

export function FileIcon({ name, className = ICON }: P & { name: string }) {
  const kind = fileKind(name)
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" data-kind={kind}>
      {kind === "jar" ? (
        <><path d="M4 7l8-4 8 4v10l-8 4-8-4z" fill="#b0743c" /><path d="M4 7l8 4 8-4M12 11v10" fill="none" stroke="#7a4d22" strokeWidth="1.4" /></>
      ) : (
        <>
          <path d={SHEET} fill={kind === "xml" ? "#f1a33c" : kind === "config" ? "#7f8c9d" : kind === "log" ? "#8aa4c8" : "#a0a7b4"} />
          <path d="M14 2v5h5" fill="#ffffff" fillOpacity=".45" />
          {kind === "xml" && <path d="M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
          {kind === "config" && <><circle cx="12" cy="15" r="2.6" fill="none" stroke="#fff" strokeWidth="1.5" /><circle cx="12" cy="15" r=".9" fill="#fff" /></>}
          {kind === "log" && <path d="M8 12h8M8 15h8M8 18h5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />}
          {kind === "file" && <path d="M8 13h8M8 16h6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />}
        </>
      )}
    </svg>
  )
}
