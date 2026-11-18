import { MidError } from "./names"

/** Turns a MidError into `{ code, message }` JSON with its status; null for anything else (caller rethrows). */
export function midErrorResponse(e: unknown): Response | null {
  if (!(e instanceof MidError)) return null
  return Response.json({ code: e.code, message: e.message }, { status: e.status })
}
