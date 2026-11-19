// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { UninstallDialog } from "./UninstallDialog"

class FakeES {
  onmessage: ((e: MessageEvent) => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  addEventListener(t: string, fn: (e: MessageEvent) => void) { (this.listeners[t] ??= []).push(fn) }
  close() {}
}

const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }))
const ADMIN = { isAdmin: true, userId: "u1" }
const mid = { name: "mid-a", instanceUrl: "https://dev1.service-now.com", midName: "sn mid&a" }
let calls: { url: string; method: string; body?: string }[]
let jobStatus: string
let deleteReply: () => Promise<Response>

beforeEach(() => {
  calls = []
  jobStatus = "running"
  deleteReply = () => json({ jobId: "u1" }, 202)
  vi.stubGlobal("EventSource", FakeES)
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: init?.body as string | undefined })
    if (method === "DELETE") return deleteReply()
    if (url.endsWith("/jobs/u1")) return json({ id: "u1", kind: "uninstall", midName: "mid-a", stage: "archive", status: jobStatus, error: null, stages: ["stop", "archive", "markRemoved"], params: {} })
    return json({ message: "no" }, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const confirmBtn = () => screen.getByRole("button", { name: "Uninstall" }) as HTMLButtonElement
const type = (v: string) => fireEvent.change(screen.getByLabelText(/พิมพ์ชื่อ MID/), { target: { value: v } })

describe("UninstallDialog", () => {
  it("explains that the instance record is not deleted and gates confirm on the exact name", () => {
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={() => {}} />)
    expect(screen.getByText(/ไม่ถูกลบ/)).toBeTruthy()
    expect(confirmBtn().disabled).toBe(true)
    type("mid-")
    expect(confirmBtn().disabled).toBe(true)
    type("MID-A")
    expect(confirmBtn().disabled).toBe(true)
    type("mid-a ")
    expect(confirmBtn().disabled).toBe(true) // not trimmed
    type(" mid-a")
    expect(confirmBtn().disabled).toBe(true)
    type("mid-a")
    expect(confirmBtn().disabled).toBe(false)
  })

  it("Esc closes before confirming", () => {
    const onClose = vi.fn()
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={onClose} />)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Enter in the field cannot submit while the name does not match", () => {
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={() => {}} />)
    type("nope")
    fireEvent.submit(screen.getByLabelText(/พิมพ์ชื่อ MID/).closest("form")!)
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0)
  })

  it("sends DELETE {confirmName} and shows job progress on 202, then the encoded instance record link on success", async () => {
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={() => {}} />)
    type("mid-a")
    fireEvent.click(confirmBtn())
    await screen.findByRole("list", { name: "Steps" })
    const del = calls.find((c) => c.method === "DELETE")!
    expect(del.url).toBe("/midhub/api/mids/mid-a")
    expect(JSON.parse(del.body!)).toEqual({ confirmName: "mid-a" })
    expect(screen.queryByText("ลบ record นี้ใน instance เองถ้าไม่ใช้แล้ว")).toBeNull()
  })

  it("shows the record link once the uninstall job succeeded", async () => {
    jobStatus = "succeeded"
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={() => {}} />)
    type("mid-a")
    fireEvent.click(confirmBtn())
    expect(await screen.findByText("ลบ record นี้ใน instance เองถ้าไม่ใช้แล้ว")).toBeTruthy()
    const a = screen.getByRole("link", { name: "Open in ServiceNow" }) as HTMLAnchorElement
    expect(a.href).toBe("https://dev1.service-now.com/ecc_agent_list.do?sysparm_query=name=sn%20mid%26a")
  })

  it("shows the server error and stays on the confirm step when DELETE fails", async () => {
    deleteReply = () => json({ code: "job_active", message: "มีงานอื่นกำลังทำอยู่" }, 409)
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={() => {}} />)
    type("mid-a")
    fireEvent.click(confirmBtn())
    expect(await screen.findByText(/มีงานอื่นกำลังทำอยู่/)).toBeTruthy()
    await waitFor(() => expect(confirmBtn().disabled).toBe(false))
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull()
  })

  it("rejects a 202 without a job id", async () => {
    deleteReply = () => json({}, 202)
    render(<UninstallDialog viewer={ADMIN} mid={mid} onClose={() => {}} />)
    type("mid-a")
    fireEvent.click(confirmBtn())
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull()
  })

  it("resume mode skips typing, shows the job, and the record link after success", async () => {
    jobStatus = "succeeded"
    render(<UninstallDialog viewer={ADMIN} mid={mid} jobId="u1" onClose={() => {}} />)
    expect(screen.queryByLabelText(/พิมพ์ชื่อ MID/)).toBeNull()
    expect(await screen.findByText("ลบ record นี้ใน instance เองถ้าไม่ใช้แล้ว")).toBeTruthy()
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0)
  })

  it("reports the shown job id when closed (so the host can remember the dismissal)", async () => {
    const onClose = vi.fn()
    render(<UninstallDialog viewer={ADMIN} mid={mid} jobId="u1" onClose={onClose} />)
    await screen.findByRole("list", { name: "Steps" })
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledWith("u1")
  })

  it("resume mode as a member: failed uninstall shows no retry and the admin-only reason", async () => {
    jobStatus = "failed"
    render(<UninstallDialog viewer={{ isAdmin: false, userId: "m1" }} mid={mid} jobId="u1" onClose={() => {}} />)
    expect(await screen.findByText(/ต้องเป็น Admin/)).toBeTruthy()
    expect(screen.queryByText("Retry")).toBeNull()
  })

  it("resume mode as an admin: failed uninstall offers retry", async () => {
    jobStatus = "failed"
    render(<UninstallDialog viewer={ADMIN} mid={mid} jobId="u1" onClose={() => {}} />)
    expect(await screen.findByText("Retry")).toBeTruthy()
  })
})
