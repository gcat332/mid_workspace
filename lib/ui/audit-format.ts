// Pure formatting for the audit page (unit tested; no React).

const ACTION_LABELS: Record<string, string> = {
  "mid.import": "Import MID",
  "mid.start": "Start MID",
  "mid.stop": "Stop MID",
  "mid.restart": "Restart MID",
  "mid.fix_ownership": "Repair Permissions",
  "mid.reconcile": "Reconcile MID State",
  "job.create": "Create Install Job",
  "job.retry": "Retry Job",
  "job.cancel": "Cancel Job",
  "mid.agent_access": "AgentHub Access",
  "mid.uninstall": "Uninstall MID",
  "config.save": "Save Configuration",
  "config.rollback": "Roll Back Configuration",
  "file.write": "Edit File",
  "file.upload": "Upload File",
  "file.rename": "Rename File",
  "file.delete": "Delete File",
  "file.mkdir": "New Folder",
  "auth.login": "Sign In (AgentHub)",
  "auth.denied": "Access Denied",
  // Written by the Agent API when its actor (an AgentHub admin) had no MidHub row yet (lib/agent/auth.ts).
  "user.created": "Create User (AgentHub Admin)",
  // user.create / user.delete / idp.update: no longer written (local login removed); kept for old rows.
  "user.create": "Add User",
  "user.update": "Edit User",
  "user.delete": "Delete User",
  "idp.update": "Edit SSO Settings",
  "instance.create": "Add Instance",
  "instance.update": "Edit Instance",
  "instance.delete": "Delete Instance",
  "instance.test": "Test Instance Connection",
  "ip_allowlist.add": "Add IP Allowlist Entry",
  "ip_allowlist.remove": "Delete IP Allowlist Entry",
  "agent.file.write": "AgentHub Edit File",
  "agent.file.upload": "AgentHub Upload File",
  "agent.file.mkdir": "AgentHub New Folder",
  "agent.file.rename": "AgentHub Rename File",
  "agent.file.delete": "AgentHub Delete File",
  "agent.restart": "AgentHub Restart MID",
  "agent.check_failed": "AgentHub Denied (Check Failed)",
}

/** English label of an audit action, or null when unknown (the page then shows the raw action name). */
export const actionLabel = (action: string): string | null => ACTION_LABELS[action] ?? null

const KEY_LABELS: Record<string, string> = {
  via: "Via",
  taskId: "Task (AgentHub)",
  sessionInstances: "Session Instances",
  failed: "Failed Checks",
  mid: "MID",
  path: "Path",
  file: "File",
  to: "Renamed To",
  size: "Size",
  backupId: "backup",
  note: "Note",
  targetEmail: "User",
  email: "Email",
  role: "Role",
  ssoOnly: "SSO Only",
  unlock: "Unlock",
  lock: "Lock",
  reason: "Reason",
  passwordChanged: "Password Changed",
  cidr: "IP/CIDR",
  enabled: "Enabled",
  provider: "Provider",
  issuer: "Issuer",
  clientId: "Client ID",
  secretChanged: "Client Secret Changed",
  instanceUrl: "Instance",
  url: "URL",
  label: "Name",
  revived: "Re-imported",
  confirmLowMemory: "Low RAM Confirmed",
  fixOwnership: "Repair Permissions",
  ok: "Result",
  code: "Error Code",
  kind: "Job Kind",
  snName: "MID Server Name",
  cloneFrom: "Clone From",
  jobId: "Job",
  cancelledJobId: "Cancelled Job",
  cancelledKind: "Cancelled Job Kind",
  cleanupJobId: "Cleanup Job",
}

const ROLE_TH: Record<string, string> = { admin: "Administrator", member: "Member" }
const REASON_TH: Record<string, string> = {
  signed_out: "ยังไม่ได้เข้าสู่ระบบ AgentHub",
  not_admin: "ไม่ใช่ admin ของ AgentHub",
  unreachable: "ติดต่อ AgentHub ไม่ได้",
  locked: "บัญชีถูกล็อกใน MidHub",
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function valueText(key: string, v: unknown): string {
  if (key === "ok" && typeof v === "boolean") return v ? "Succeeded" : "Failed"
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (key === "size" && typeof v === "number") return bytes(v)
  if (key === "role" && typeof v === "string") return ROLE_TH[v] ?? v
  if (key === "reason" && typeof v === "string") return REASON_TH[v] ?? v
  if (v === null || v === undefined || v === "") return "-"
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.length ? v.join(", ") : "-"
  return typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)
}

/** Readable `[label, value]` pairs of an audit detail; null when the detail is not a JSON object. */
export function detailPairs(detail: string): [string, string][] | null {
  let j: unknown
  try { j = JSON.parse(detail) } catch { return null }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null
  // AgentHub entries lead with who acted through what: via + taskId first.
  const rank = (k: string) => (k === "via" ? 0 : k === "taskId" ? 1 : 2)
  const entries = Object.entries(j).sort(([a], [b]) => rank(a) - rank(b))
  return entries.map(([k, v]) => [KEY_LABELS[k] ?? k, valueText(k, v)])
}

/** Compact one-line JSON; falls back to the raw text when detail is not valid JSON. */
export function compactDetail(detail: string): string {
  try { return JSON.stringify(JSON.parse(detail)) } catch { return detail }
}
