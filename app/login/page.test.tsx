import { beforeEach, expect, it, vi } from "vitest"

const getSessionUser = vi.hoisted(() => vi.fn())
const redirect = vi.hoisted(() => vi.fn((to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { to }) }))
vi.mock("@/lib/auth/helpers", () => ({ getSessionUser }))
vi.mock("next/navigation", () => ({ redirect, useSearchParams: () => new URLSearchParams() }))

beforeEach(() => { getSessionUser.mockReset(); redirect.mockClear() })

it("valid JWT but revoked user (getSessionUser -> null): the login form renders, no redirect (I1)", async () => {
  getSessionUser.mockResolvedValue(null)
  const { default: LoginPage } = await import("./page")
  const el = await LoginPage()
  expect(el).toBeTruthy()
  expect(redirect).not.toHaveBeenCalled()
})

it("a live session is sent on to the app", async () => {
  getSessionUser.mockResolvedValue({ userId: "u1", email: "a@x.com", role: "member", authAt: 1 })
  const { default: LoginPage } = await import("./page")
  await expect(LoginPage()).rejects.toMatchObject({ to: "/" })
})
