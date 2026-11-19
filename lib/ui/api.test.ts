import { describe, it, expect, vi, afterEach } from "vitest"
import { apiFetch, apiUpload } from "./api"

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

/** Minimal XMLHttpRequest stand-in: the test answers each request with respond(). */
class FakeXHR {
  static last: FakeXHR | null = null
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  status = 0
  responseText = ""
  type = ""
  url = ""
  open(_m: string, url: string) { this.url = url }
  send() { FakeXHR.last = this }
  getResponseHeader() { return this.type || null }
  respond(status: number, text: string, type: string) { this.status = status; this.responseText = text; this.type = type; this.onload?.() }
}

describe("apiUpload", () => {
  it("reports progress and resolves with the JSON reply", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR)
    const seen: number[] = []
    const p = apiUpload("/mids/m1/files", new FormData(), (n) => seen.push(n))
    const xhr = FakeXHR.last!
    expect(xhr.url).toBe("/midhub/api/mids/m1/files")
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 })
    xhr.respond(200, '{"size":4}', "application/json")
    const res = await p
    expect(seen).toEqual([25])
    expect(await res.json()).toEqual({ size: 4 })
  })
  it("an HTML 200 reply (F5 WAF page) becomes the 502 rejected_by_network error", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR)
    const p = apiUpload("/mids/m1/files", new FormData(), () => {})
    FakeXHR.last!.respond(200, F5_PAGE, "text/html; charset=utf-8")
    const res = await p
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe("rejected_by_network")
  })
  it("rejects on a network failure", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR)
    const p = apiUpload("/mids/m1/files", new FormData(), () => {})
    FakeXHR.last!.onerror?.()
    await expect(p).rejects.toThrow()
  })
  it("rejects (never hangs) when building the Response throws, e.g. status 0", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR)
    const p = apiUpload("/mids/m1/files", new FormData(), () => {})
    FakeXHR.last!.respond(0, "", "text/plain")
    await expect(p).rejects.toThrow()
  })
})
