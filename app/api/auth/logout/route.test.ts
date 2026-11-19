import { expect, it } from "vitest"
import { POST } from "./route"

// Logout never redirects on the server (no absolute Location to leak 127.0.0.1 or http:// behind AgentHub's
// rewrite): it clears the cookie and the client navigates with router.replace("/login?reason=logged_out"),
// a basePath-relative path.
it("logout answers JSON with no Location and clears midhub_session on /midhub", async () => {
  const res = await POST()
  expect(res.status).toBe(200)
  expect(res.headers.get("location")).toBeNull()
  expect(await res.json()).toEqual({ ok: true })
  const sc = res.headers.get("set-cookie") ?? ""
  expect(sc).toMatch(/midhub_session=;/)
  expect(sc).toContain("Path=/midhub")
  expect(sc).toMatch(/Max-Age=0/)
})
