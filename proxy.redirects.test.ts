import { describe, it, expect, vi, beforeEach } from "vitest"
import { AsyncLocalStorage } from "node:async_hooks"
import { execFileSync } from "node:child_process"
import path from "node:path"

// Every redirect MidHub emits must be relative (/midhub/...): behind AgentHub's rewrite the F5 sends no
// X-Forwarded-Proto and Host is 127.0.0.1:3100, so an absolute Location would drop the browser to http:// or
// send it to the loopback address. These tests run proxy.ts through Next's real proxy adapter (the code that
// turns the proxy's response into the HTTP response), with the request URL Next builds in production from its
// own listen address, so they assert the Location the browser actually gets.

let cidrs: string[] = []
vi.mock("@/lib/db/client", () => ({ prisma: { ipAllowlist: { findMany: vi.fn(async () => cidrs.map((cidr) => ({ cidr }))) } } }))
vi.mock("@/lib/auth/denial-audit", () => ({ auditDenied: vi.fn(async () => {}) }))
// Nothing listens on port 1: an AgentHub re-verify fails as "unreachable" (access page redirect).
vi.mock("@/lib/env", () => ({ env: { agenthubUrl: "http://127.0.0.1:1", agenthubServiceUser: null } }))

// Next's server modules need the AsyncLocalStorage global that the real Next runtime installs.
;(globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage
// Internal module of the pinned next@16.4.6, not typed in the package's .d.ts.
type AdapterFn = (p: Record<string, unknown>) => Promise<{ response: Response }>
const { adapter } = (await import("next/dist/server/web/adapter")) as unknown as { adapter: AdapterFn }
const { NextResponse } = await import("next/server")
const { proxy } = await import("@/proxy")
const { signToken } = await import("@/lib/auth/jwt")

// Header shapes MidHub sees. Rewrite: AgentHub's Next proxy (httpxy, changeOrigin) sets Host to the target and
// X-Forwarded-Host to the browser's host; the F5 adds the client in X-Forwarded-For and no X-Forwarded-Proto.
const REWRITE = { host: "127.0.0.1:3100", "x-forwarded-host": "dev-agenthub.mfec.co.th", "x-forwarded-for": "10.20.30.40" }
const CADDY = { host: "10.4.150.142", "x-forwarded-host": "10.4.150.142", "x-forwarded-proto": "https", "x-forwarded-for": "10.20.30.40" }

// Production builds the proxy's request URL from the server's own address (next-server.js runEdgeFunction /
// attachRequestMeta), never from Host; the scheme follows X-Forwarded-Proto.
async function throughNext(p: string, headers: Record<string, string>, handler: unknown = proxy): Promise<Response> {
  const proto = headers["x-forwarded-proto"]?.includes("https") ? "https" : "http"
  const { response } = await adapter({
    handler,
    page: "/proxy",
    request: {
      url: `${proto}://127.0.0.1:3100/midhub${p}`,
      headers,
      method: "GET",
      nextConfig: { basePath: "/midhub" },
      page: { name: "/proxy" },
      signal: new AbortController().signal,
    },
  })
  return response
}

function expectRelative(res: Response): string {
  expect([303, 307, 308]).toContain(res.status)
  const loc = res.headers.get("location") ?? ""
  expect(loc).toMatch(/^\/midhub(?:[/?]|$)/)
  expect(loc).not.toMatch(/^\/\/|:\/\//) // no scheme, no host, not protocol-relative
  return loc
}

const nowS = () => Math.floor(Date.now() / 1000)
const staleCookie = async () =>
  `midhub_session=${await signToken({ userId: "u1", email: "a@x.com", role: "admin", ahAt: nowS() - 3600 })}; session=ah`

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  cidrs = []
  warn?.mockRestore()
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) // the unreachable lookup's diagnostics
})

describe.each([["AgentHub rewrite", REWRITE], ["Caddy", CADDY]])("redirects are relative (%s)", (_n, shape) => {
  it("gate: a page without a session -> /midhub/api/auth/agenthub?next=...", async () => {
    const loc = expectRelative(await throughNext("/mids?x=1", shape))
    expect(loc).toBe("/midhub/api/auth/agenthub?next=%2Fmids%3Fx%3D1")
  })
  it("gate: the bare app root /midhub", async () => {
    expect(expectRelative(await throughNext("", shape))).toBe("/midhub/api/auth/agenthub?next=%2F")
  })
  it("access page: re-verify fails (AgentHub unreachable) -> /midhub/login?reason=unreachable", async () => {
    const res = await throughNext("/mids", { ...shape, cookie: await staleCookie() })
    expect(expectRelative(res)).toBe("/midhub/login?reason=unreachable")
  })
})

it("Next's adapter rejects a bare relative Location from the proxy, which is why redirectTo builds a same-origin URL", async () => {
  // Pins next@16.4.6 behaviour: the adapter parses the proxy's Location with new URL(loc) (no base) and throws.
  // A same-origin absolute URL is what it turns into the relative Location asserted above.
  const bare = () => new NextResponse(null, { status: 307, headers: { location: "/midhub/login" } })
  await expect(throughNext("/mids", REWRITE, bare)).rejects.toThrow(/Invalid URL/)
})

it("no other redirect in app/ or lib/ can produce an absolute Location", () => {
  const root = path.resolve(__dirname)
  const grep = (re: string) => {
    try {
      return execFileSync("/usr/bin/grep", ["-rnE", re, "app", "lib", "--include=*.ts", "--include=*.tsx"], { cwd: root, encoding: "utf8" })
        .split("\n").filter((l) => l && !/\.test\.tsx?:/.test(l))
    } catch { return [] } // grep exits 1 on no match
  }
  // NextResponse.redirect / Response.redirect require an absolute URL; only proxy.ts may use it (see above).
  expect(grep("(NextResponse|Response)\\.redirect\\(")).toEqual([])
  // next/navigation redirect(): Next prefixes basePath to the path given, so it must be an in-app path literal.
  const calls = grep("\\bredirect\\(")
  expect(calls.length).toBeGreaterThan(0)
  for (const l of calls) expect(l, l).toMatch(/\bredirect\("\/[^/]/)
  // The only Location set by hand is the sign-in route's `see` (relative, asserted in its route.test.ts).
  expect(grep("[\"']?location[\"']?\\s*[:,]|set\\([\"']location").map((l) => l.split(":")[0])).toEqual(["app/api/auth/agenthub/route.ts"])
})
