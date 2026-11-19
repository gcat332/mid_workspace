import { beforeEach, expect, it, vi } from "vitest"

const create = vi.hoisted(() => vi.fn<(a: unknown) => Promise<object>>(async () => ({})))
vi.mock("@/lib/db/client", () => ({ prisma: { auditLog: { create } } }))

import { auditDenied, resetDenialAudit } from "./denial-audit"

beforeEach(() => { create.mockClear(); resetDenialAudit() })

it("writes auth.denied {reason} with the email (or empty) and no other detail", async () => {
  await auditDenied("not_admin", { ip: "10.0.0.1" })
  await auditDenied("locked", { email: "A@x.com", ip: "10.0.0.1" })
  expect(create.mock.calls.map((c) => c[0])).toEqual([
    { data: { userId: null, email: "", action: "auth.denied", midName: null, detail: '{"reason":"not_admin"}' } },
    { data: { userId: null, email: "a@x.com", action: "auth.denied", midName: null, detail: '{"reason":"locked"}' } },
  ])
})

it("at most once per reason per 10 minutes per email/IP", async () => {
  const t0 = 1_000_000_000_000
  await auditDenied("signed_out", { ip: "10.0.0.1" }, t0)
  await auditDenied("signed_out", { ip: "10.0.0.1" }, t0 + 60_000) // same key: suppressed
  await auditDenied("unreachable", { ip: "10.0.0.1" }, t0 + 60_000) // other reason
  await auditDenied("signed_out", { ip: "10.0.0.2" }, t0 + 60_000) // other IP
  await auditDenied("signed_out", { email: "a@x.com", ip: "10.0.0.1" }, t0 + 60_000) // email takes precedence over IP
  await auditDenied("signed_out", { ip: "10.0.0.1" }, t0 + 10 * 60_000 + 1) // window over
  expect(create).toHaveBeenCalledTimes(5)
})

it("a failed write never throws", async () => {
  create.mockRejectedValueOnce(new Error("db locked"))
  const err = vi.spyOn(console, "error").mockImplementation(() => {})
  await expect(auditDenied("signed_out", { ip: "x" })).resolves.toBeUndefined()
  err.mockRestore()
})
