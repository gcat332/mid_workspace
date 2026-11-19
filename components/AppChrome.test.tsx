// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ replace: () => {}, push: () => {} }) }))
vi.mock("./ProfileMenu", () => ({ ProfileMenu: () => null }))

import { AppChrome } from "./AppChrome"

afterEach(cleanup)

describe("AppChrome header (matches AgentHub)", () => {
  const setup = () => render(<AppChrome user={{ email: "a@b.c", role: "admin" }}>x</AppChrome>).container

  it("uses AgentHub's header spacing", () => {
    const c = setup()
    const header = c.querySelector("header")!
    expect(header.className).toContain("px-5")
    expect(header.className).not.toContain("gap-2")
    for (const img of Array.from(c.querySelectorAll("img"))) {
      expect(img.className).toContain("h-7")
      expect(img.className).toContain("-mt-1.5")
    }
    expect(c.querySelector("header span.w-px")!.className).toContain("mx-2")
    expect(c.querySelector("header span.font-bold")!.className).toContain("text-2xl md:text-[31px] leading-8 md:leading-9")
  })

  it("uses AgentHub's nav spacing and stays visible on phones", () => {
    const c = setup()
    const nav = c.querySelector("nav")!
    expect(nav.className).toContain("gap-5 md:gap-7 px-4 md:px-8")
    expect(c.querySelector("header")!.className).not.toContain("max-md:hidden")
    expect(nav.className).not.toContain("max-md:hidden")
  })
})
