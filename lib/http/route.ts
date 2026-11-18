import { midErrorResponse } from "@/lib/mids/http"

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
