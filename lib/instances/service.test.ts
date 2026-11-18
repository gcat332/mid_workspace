import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/db/client", () => ({ prisma: {} }))

import { normalizeInstanceUrl, testConnection } from "./service"
import { normalizeInstanceUrl as fromUrl } from "./url"

describe("normalizeInstanceUrl", () => {
  it("is re-exported from service", () => expect(normalizeInstanceUrl).toBe(fromUrl))
  it("lowercases and canonicalises", () => {
    expect(normalizeInstanceUrl("https://MFECPLCDEMO4.service-now.com")).toBe("https://mfecplcdemo4.service-now.com/")
    expect(normalizeInstanceUrl("  https://a.service-now.com/ ")).toBe("https://a.service-now.com/")
  })
  it.each([
    "http://x.service-now.com",
    "https://x.service-now.com.evil.com",
    "https://evil.com/x.service-now.com",
    "https://user:pw@x.service-now.com",
    "https://x.service-now.com:8443",
    "https://127.0.0.1",
    "https://x.service-now.com/api",
    "https://x.service-now.com/?a=1",
    "https://x.service-now.com/#f",
    "https://x.service-now.com\\@evil.com",
    "https://.service-now.com",
    "service-now.com",
    "",
  ])("rejects %s", (u) => {
    expect(() => normalizeInstanceUrl(u)).toThrowError(expect.objectContaining({ code: "instance_url", status: 400 }))
  })
})

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })
const input = { url: "https://X.service-now.com", midUser: "mid", password: "pä:ss" }

describe("testConnection", () => {
  it("never calls fetch for a rejected URL", async () => {
    const f = vi.fn()
    for (const url of ["http://x.service-now.com", "https://127.0.0.1", "https://x.service-now.com.evil.com"]) {
      await expect(testConnection({ ...input, url }, f as unknown as typeof fetch)).rejects.toMatchObject({ code: "instance_url" })
    }
    expect(f).not.toHaveBeenCalled()
  })

  it("200 -> ok, with Basic UTF-8 auth, manual redirect, normalised URL, and buildstamp from glide.war", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { result: [] }))
      .mockResolvedValueOnce(res(200, { result: [{ value: "glide-zurich-07-01-2026__patch3-10-02-2026_10-08-2026_1234.zip" }] }))
    const r = await testConnection(input, f as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, buildstamp: "zurich-07-01-2026__patch3-10-02-2026_10-08-2026_1234" })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe("https://x.service-now.com/api/now/table/ecc_agent?sysparm_limit=1")
    expect(init.redirect).toBe("manual")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("mid:pä:ss", "utf8").toString("base64"))
    expect(f.mock.calls[1][0]).toBe("https://x.service-now.com/api/now/table/sys_properties?sysparm_query=name=glide.war&sysparm_fields=value&sysparm_limit=1")
  })

  it("buildstamp null when the glide.war call is 403 or throws", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200)).mockResolvedValueOnce(res(403))
    expect(await testConnection(input, f as unknown as typeof fetch)).toEqual({ ok: true, buildstamp: null })
    const g = vi.fn().mockResolvedValueOnce(res(200)).mockRejectedValueOnce(new Error("boom"))
    expect(await testConnection(input, g as unknown as typeof fetch)).toEqual({ ok: true, buildstamp: null })
  })

  it("maps 401, 403, 5xx, 3xx, network error and timeout", async () => {
    const run = (f: unknown) => testConnection(input, f as typeof fetch)
    await expect(run(async () => res(401))).rejects.toMatchObject({ code: "instance_auth", status: 400 })
    await expect(run(async () => res(403))).rejects.toMatchObject({ code: "instance_role" })
    await expect(run(async () => res(503, "down"))).rejects.toMatchObject({ code: "instance_unreachable", status: 502 })
    await expect(run(async () => res(302, "", { location: "https://evil.com/" }))).rejects.toMatchObject({ code: "instance_unreachable" })
    await expect(run(async () => { throw new TypeError("fetch failed") })).rejects.toMatchObject({ code: "instance_unreachable" })
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" })
    await expect(run(async () => { throw timeout })).rejects.toMatchObject({ code: "instance_unreachable" })
  })

  it("never leaks the password or Authorization into errors; excerpt capped at 300", async () => {
    const body = "x".repeat(1000)
    const err = await testConnection(input, (async () => res(500, body)) as unknown as typeof fetch).catch((e) => e)
    expect(err.detail.length).toBeLessThan(400)
    expect(JSON.stringify([err.message, err.detail])).not.toMatch(/pä:ss|Basic /)
    const err2 = await testConnection(input, (async () => { throw new Error(`bad Basic ${Buffer.from("mid:pä:ss").toString("base64")} pä:ss`) }) as unknown as typeof fetch).catch((e) => e)
    expect(JSON.stringify([err2.message, err2.detail])).not.toMatch(/pä:ss|Basic /)
  })
})
