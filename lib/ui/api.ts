/** next.config basePath; <img src> and raw fetch/links are not prefixed automatically. */
export const BASE_PATH = "/midhub"
export const API_BASE = `${BASE_PATH}/api`
export const LOGIN_URL = `${BASE_PATH}/login`

/**
 * The app's API only ever answers JSON (or no body). An HTML page in its place came from a device in front of
 * MidHub, e.g. the corporate F5 WAF's "Request Rejected" page, which it sends with status 200: treat it as a
 * failure so the UI never reports a save that did not happen.
 */
async function networkRejection(res: Response): Promise<Response | null> {
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return null
  const text = await res.text().catch(() => "")
  const supportId = /support ID is:\s*([0-9]+)/i.exec(text)?.[1]
  return Response.json(
    {
      code: "rejected_by_network",
      message: "คำขอถูกอุปกรณ์เครือข่าย (F5) ปฏิเสธก่อนถึง MidHub จึงยังไม่ได้บันทึก กรุณาแจ้งทีม network พร้อม Support ID",
      detail: supportId ? `F5 support ID: ${supportId}` : `HTTP ${res.status}: ${text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`,
    },
    { status: 502 },
  )
}

/** fetch wrapper for the app's own API: a 401 (session expired) sends the user straight to the login page. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const raw = await fetch(`${API_BASE}${path}`, init)
  const res = (await networkRejection(raw)) ?? raw
  if (res.status === 401 && typeof window !== "undefined") {
    // Full navigation on purpose: drops all client state of the expired session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(LOGIN_URL)
  }
  return res
}

/** Only http(s) URLs may become links (blocks javascript: etc. from a tampered config.xml). */
export function safeHttpUrl(u: string | null): string | null {
  return u && /^https?:\/\//i.test(u) ? u : null
}
