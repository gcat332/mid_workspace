import { MidError } from "./names"

/** Subclasses may carry a `checks` array (agent_check_failed) that is added to the body; other errors are unchanged. */
function extraBody(e: MidError): Record<string, unknown> {
  const checks = (e as { checks?: unknown }).checks
  return Array.isArray(checks) ? { checks } : {}
}

/** Turns a MidError into `{ code, message }` JSON with its status; null for anything else (caller rethrows). */
export function midErrorResponse(e: unknown): Response | null {
  if (!(e instanceof MidError)) return null
  return Response.json({ code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}), ...extraBody(e) }, { status: e.status })
}
