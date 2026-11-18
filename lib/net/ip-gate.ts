// The IP allowlist gate, shared by proxy.ts (browser paths) and lib/agent/auth.ts (/api/agent/*, which the proxy
// matcher excludes so Next never buffers those request bodies).
import { clientIpFrom, isAllowed } from "@/lib/net/ip-allowlist"

/** The client IP that fails the allowlist, or null when it is allowed (loopback always is). */
export async function blockedClientIp(headers: Headers): Promise<string | null> {
  const ip = clientIpFrom(headers)
  return (await isAllowed(ip)) ? null : ip
}

/** API 403 `{ code: "ip_blocked", message, ip }`; echoes the IP so a blocked admin knows what to whitelist. */
export function ipBlockedResponse(ip: string): Response {
  return Response.json({ code: "ip_blocked", message: `IP ของคุณ (${ip}) ไม่อยู่ใน IP Allowlist กรุณาให้ Admin เพิ่ม IP นี้`, ip }, { status: 403 })
}
