import { beforeEach, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const getSessionUser = vi.hoisted(() => vi.fn())
const sessionLocked = vi.hoisted(() => vi.fn(async () => false))
const redirect = vi.hoisted(() => vi.fn((to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { to }) }))
vi.mock("@/lib/auth/helpers", () => ({ getSessionUser, sessionLocked }))
vi.mock("next/navigation", () => ({ redirect }))

beforeEach(() => {
  getSessionUser.mockReset(); getSessionUser.mockResolvedValue(null)
  sessionLocked.mockReset(); sessionLocked.mockResolvedValue(false)
  redirect.mockClear()
})

const render = async (reason?: string | string[]) => {
  const { default: LoginPage } = await import("./page")
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(reason === undefined ? {} : { reason }) }))
}

it("revoked or missing session: the access page renders, no redirect (no loop)", async () => {
  const html = await render("signed_out")
  expect(html).toBeTruthy()
  expect(redirect).not.toHaveBeenCalled()
})

it("a live session is sent on to the app", async () => {
  getSessionUser.mockResolvedValue({ userId: "u1", email: "a@x.com", role: "admin", authAt: 1, ahAt: 1 })
  await expect(render()).rejects.toMatchObject({ to: "/" })
})

it("links to AgentHub's own /login (absolute path, no /midhub) with the English button and Thai note", async () => {
  const html = await render("signed_out")
  expect(html).toContain('href="/login"')
  expect(html).toContain("Sign In with AgentHub")
  expect(html).toContain("เข้าสู่ระบบ AgentHub ด้วยบัญชี admin แล้วกลับมาที่ /midhub")
  expect(html).not.toContain('href="/midhub/login"')
  // no local login of any kind
  expect(html).not.toContain("<form")
  expect(html).not.toContain('type="password"')
})

it("reason-specific text; unknown reasons fall back to the generic text", async () => {
  const texts = {
    signed_out: await render("signed_out"),
    not_admin: await render("not_admin"),
    unreachable: await render("unreachable"),
    locked: await render("locked"),
    logged_out: await render("logged_out"),
  }
  expect(texts.signed_out).toContain("Signed Out of AgentHub")
  expect(texts.not_admin).toContain("ไม่ใช่ admin")
  expect(texts.unreachable).toContain("AgentHub Unreachable")
  expect(texts.locked).toContain("ถูกล็อก")
  expect(texts.logged_out).toContain("Signed Out of MidHub")
  expect(new Set(Object.values(texts)).size).toBe(5)
  const unknown = await render("<script>alert(1)</script>")
  expect(unknown).not.toContain("<script>alert(1)")
  expect(unknown).toContain("Sign In with AgentHub")
  expect(await render(["not_admin", "x"])).toContain("ไม่ใช่ admin")
})

it("no reason but the MidHub session belongs to a locked user -> locked text", async () => {
  sessionLocked.mockResolvedValue(true)
  expect(await render()).toContain("ถูกล็อก")
})
