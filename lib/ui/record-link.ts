import { safeHttpUrl } from "./api"

/** Link to the MID Server record (by its ServiceNow name) in the instance's agent list; null when the URL is unusable. */
export function instanceRecordUrl(instanceUrl: string | null, snName: string | null): string | null {
  const base = safeHttpUrl(instanceUrl)
  if (!base || !snName) return null
  return `${base.replace(/\/+$/, "")}/ecc_agent_list.do?sysparm_query=name=${encodeURIComponent(snName)}`
}
