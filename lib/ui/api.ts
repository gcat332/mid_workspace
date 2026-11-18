/** next.config basePath; <img src> and raw fetch/links are not prefixed automatically. */
export const BASE_PATH = "/midhub"
export const API_BASE = `${BASE_PATH}/api`
export const LOGIN_URL = `${BASE_PATH}/login`

/** fetch wrapper for the app's own API: a 401 (session expired) sends the user straight to the login page. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, init)
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
