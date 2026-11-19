import { describe, it, expect, vi, afterEach } from "vitest"
import { apiFetch } from "./api"

const F5_PAGE = "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 11568909658494429161<br><br><a href='javascript:history.back();'>[Go Back]</a></body></html>"

afterEach(() => vi.unstubAllGlobals())

describe("apiFetch", () => {
  it("an HTML page instead of the API's JSON (F5 WAF 'Request Rejected', status 200) becomes a 502 error with the support ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(F5_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })))
    const res = await apiFetch("/mids/m1", { method: "POST" })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe("rejected_by_network")
    expect(body.message).toMatch(/F5|เครือข่าย/)
    expect(body.detail).toContain("11568909658494429161")
  })
  it("JSON responses and empty bodies pass through untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agentAccess: true })))
    const res = await apiFetch("/mids/m1")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agentAccess: true })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })))
    expect((await apiFetch("/x")).status).toBe(204)
  })
})
