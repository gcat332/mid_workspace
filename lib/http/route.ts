import { midErrorResponse } from "@/lib/mids/http"

/** The app's one error shape: `{ code, message, detail? }` (message is user-facing Thai, cause + fix). */
export function jsonError(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ code, message, ...extra }, { status })
}

/** Parses a JSON object body; null for invalid JSON or anything that is not a plain object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const b: unknown = await req.json().catch(() => null)
  return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null
}

/** Last-resort catch for route handlers: Response passes through, MidError maps to its status, the rest is a logged 500. */
export function handleRouteError(e: unknown): Response {
  if (e instanceof Response) return e
  const mid = midErrorResponse(e)
  if (mid) return mid
  console.error("[route] unhandled error:", e)
  return Response.json(
    {
      code: "internal",
      message: "เกิดข้อผิดพลาดภายในระบบ ลองใหม่อีกครั้ง หากยังไม่ได้ให้แจ้ง Admin",
      detail: e instanceof Error ? e.message : String(e),
    },
    { status: 500 },
  )
}
