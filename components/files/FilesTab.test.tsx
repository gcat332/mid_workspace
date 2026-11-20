// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
// apiUpload stays real so uploads go through the stubbed XMLHttpRequest below.
vi.mock("@/lib/ui/api", async (orig) => ({ ...(await orig<typeof import("@/lib/ui/api")>()), apiFetch: api.apiFetch }))
const monaco = vi.hoisted(() => ({ options: null as unknown }))
vi.mock("@monaco-editor/react", () => ({
  default: (p: { value: string; onChange: (v: string) => void; options: { readOnly: boolean } }) => {
    monaco.options = p.options
    return <textarea aria-label="editor" value={p.value} readOnly={p.options.readOnly} onChange={(e) => p.onChange(e.target.value)} />
  },
}))

import { FilesTab } from "../FilesTab"

type Flags = Partial<{ readOnly: boolean; locked: boolean; secret: boolean; config: boolean; size: number }>
const E = (name: string, type: "file" | "dir", f: Flags = {}) =>
  ({ name, type, size: 10, mtime: "2026-11-19T00:00:00Z", readOnly: false, symlink: false, locked: false, secret: false, config: false, ...f })
let FS: Record<string, { entries: ReturnType<typeof E>[]; readOnly: boolean }>
let putReply: () => Response
let deleteReply: (path: string | null) => Response
let zipReply: () => Response
const zipUrls: string[] = []

type Call = { method: string; path: string | null; content: boolean; body: unknown }
const calls: Call[] = []
const sent = (method: string) => calls.filter((c) => c.method === method)

beforeEach(() => {
  FS = {
    "": { entries: [E("notes.txt", "file"), E("agent", "dir")], readOnly: false },
    agent: {
      entries: [E("x.xml", "file", { readOnly: true }), E("config.xml", "file", { config: true, locked: true }), E("secret.key", "file", { secret: true }), E("extlib", "dir")],
      readOnly: true,
    },
    "agent/extlib": { entries: [E("a.jar", "file")], readOnly: false },
  }
  putReply = () => Response.json({ hash: "h2" })
  deleteReply = () => Response.json({})
  zipReply = () => Response.json({ files: 2, bytes: 20 })
  zipUrls.length = 0
  calls.length = 0
  api.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x")
    const method = init?.method ?? "GET"
    if (u.pathname.endsWith("/files/zip")) { zipUrls.push(url); return zipReply() }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
    calls.push({ method, path: u.searchParams.get("path"), content: u.searchParams.get("content") === "1", body })
    if (method === "GET" && u.searchParams.get("content") === "1") return Response.json({ content: "hello", hash: "h1" })
    if (method === "GET") {
      const d = FS[u.searchParams.get("path") ?? ""]
      return d ? Response.json(d) : Response.json({ code: "not_found", message: "ไม่พบ" }, { status: 404 })
    }
    if (method === "PUT") return putReply()
    if (method === "DELETE") return deleteReply(u.searchParams.get("path"))
    return Response.json({})
  })
})
afterEach(() => { cleanup(); api.apiFetch.mockReset(); vi.unstubAllGlobals() })

/** A tree row's main button (the breadcrumb has same-named buttons). */
const row = (name: string | RegExp) => screen.getAllByRole("button", { name }).find((b) => b.closest("[data-row]"))!
const listed = (path: string) => calls.some((c) => c.method === "GET" && !c.content && c.path === path)
async function setup(props: { busyReason?: string | null; onOpenConfig?: () => void } = {}) {
  const onOpenConfig = props.onOpenConfig ?? vi.fn()
  const r = render(<FilesTab midName="m1" busyReason={props.busyReason ?? null} onOpenConfig={onOpenConfig} />)
  await screen.findByRole("button", { name: "notes.txt" })
  return { ...r, onOpenConfig }
}
async function expandAgent() {
  fireEvent.click(row("agent"))
  await screen.findByRole("button", { name: /^x\.xml/ })
}
const ctrlS = (el: Element) => fireEvent.keyDown(el, { key: "s", ctrlKey: true })
async function openNotes() {
  fireEvent.click(row("notes.txt"))
  const dlg = await screen.findByRole("dialog", { name: "notes.txt" })
  const editor = await within(dlg).findByRole("textbox", { name: "editor" })
  return { dlg, editor }
}

describe("FilesTab tree", () => {
  it("clicking a folder expands it, lists it lazily and indents its children", async () => {
    const { container } = await setup()
    expect(listed("agent")).toBe(false)
    // directories first
    expect([...container.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["agent", "notes.txt"])
    await expandAgent()
    expect(listed("agent")).toBe(true)
    const child = container.querySelector('[data-row="agent/x.xml"]') as HTMLElement
    expect(child.style.paddingLeft).toBe("20px")
    expect((container.querySelector('[data-row="agent"]') as HTMLElement).style.paddingLeft).toBe("6px")
    expect(row("agent").getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(row("agent"))
    expect(container.querySelector('[data-row="agent/x.xml"]')).toBeNull()
  })

  it("toolbar buttons carry English labels and tooltips", async () => {
    await setup()
    for (const name of ["Upload", "New File", "New Folder", "Refresh"]) {
      expect(screen.getByRole("button", { name }).getAttribute("title")).toBe(name)
    }
  })

  it("shows the program-folder read-only hint and the extlib note", async () => {
    await setup()
    await expandAgent()
    expect(screen.getByText(/โฟลเดอร์โปรแกรมของ MID แก้ไขไม่ได้/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "agent/extlib" }))
    await screen.findByText(/jar ใน extlib จะถูกลบตอน MID เริ่มทำงาน/)
    expect(listed("agent/extlib")).toBe(true)
    await screen.findByRole("button", { name: "a.jar" })
  })
})

describe("FilesTab editor", () => {
  it("opens a full-screen editor; typing marks it unsaved; Ctrl+S saves with baseHash", async () => {
    await setup()
    const { dlg, editor } = await openNotes()
    expect(monaco.options).toEqual({ fontSize: 14, wordWrap: "on", minimap: { enabled: true }, scrollBeyondLastLine: false, automaticLayout: true, readOnly: false })
    expect(within(dlg).queryByText("Unsaved Changes")).toBeNull()
    fireEvent.change(editor, { target: { value: "hello world" } })
    expect(within(dlg).getByText("Unsaved Changes").textContent).toContain("●")
    ctrlS(editor)
    await within(dlg).findByText("Saved")
    expect(sent("PUT").map((c) => c.body)).toEqual([{ path: "notes.txt", content: "hello world", baseHash: "h1" }])
    expect(within(dlg).queryByText("Unsaved Changes")).toBeNull()
  })

  it("Ctrl+S sends nothing without changes", async () => {
    await setup()
    const { editor } = await openNotes()
    ctrlS(editor)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent("PUT")).toHaveLength(0)
  })

  it("Ctrl+S sends nothing for a read-only file", async () => {
    await setup()
    await expandAgent()
    fireEvent.click(row(/^x\.xml/))
    const dlg = await screen.findByRole("dialog", { name: "agent/x.xml" })
    expect(within(dlg).getByText("Read-only")).toBeTruthy()
    const editor = await within(dlg).findByRole("textbox", { name: "editor" })
    fireEvent.change(editor, { target: { value: "changed" } })
    ctrlS(editor)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent("PUT")).toHaveLength(0)
  })

  it("Ctrl+S sends nothing while a lifecycle job runs (busyReason)", async () => {
    await setup({ busyReason: "กำลังอัปเกรด MID" })
    const { dlg, editor } = await openNotes()
    expect(within(dlg).getByText(/กำลังอัปเกรด MID — แก้ไขไฟล์ไม่ได้/)).toBeTruthy()
    fireEvent.change(editor, { target: { value: "changed" } })
    ctrlS(editor)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent("PUT")).toHaveLength(0)
  })

  it("closing with unsaved changes asks first; cancelling keeps the editor", async () => {
    await setup()
    const { dlg, editor } = await openNotes()
    fireEvent.change(editor, { target: { value: "x" } })
    fireEvent.click(within(dlg).getByRole("button", { name: "Close" }))
    const confirm = await screen.findByRole("dialog", { name: "Close Without Saving?" })
    expect(within(confirm).getByText(/มีการแก้ไขที่ยังไม่บันทึก/)).toBeTruthy()
    fireEvent.click(within(confirm).getAllByRole("button")[0]) // Cancel
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Close Without Saving?" })).toBeNull())
    expect(screen.getByRole("dialog", { name: "notes.txt" })).toBeTruthy()
  })

  it("a stale save keeps the Reload File action", async () => {
    putReply = () => Response.json({ code: "stale", message: "ไฟล์ถูกแก้ไขจากที่อื่น" }, { status: 409 })
    await setup()
    const { dlg, editor } = await openNotes()
    fireEvent.change(editor, { target: { value: "x" } })
    ctrlS(editor)
    fireEvent.click(await within(dlg).findByRole("button", { name: "Reload File" }))
    await waitFor(() => expect(calls.filter((c) => c.content && c.path === "notes.txt")).toHaveLength(2))
  })
})

describe("FilesTab config files", () => {
  it("config rows show an always-visible Edit in Configuration button; other rows do not", async () => {
    const { container, onOpenConfig } = await setup()
    await expandAgent()
    const cfg = container.querySelector('[data-row="agent/config.xml"]') as HTMLElement
    const btn = within(cfg).getByRole("button", { name: "Edit in Configuration" })
    expect(btn.className).not.toMatch(/opacity-0/)
    expect(within(container.querySelector('[data-row="agent/x.xml"]') as HTMLElement).queryByRole("button", { name: "Edit in Configuration" })).toBeNull()
    fireEvent.click(btn)
    expect(onOpenConfig).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.content)).toBe(false) // did not open the raw editor
  })

  it("the editor header offers Edit in Configuration for a config file, closing straight away when clean", async () => {
    const { onOpenConfig } = await setup()
    await expandAgent()
    fireEvent.click(row(/^config\.xml/))
    const dlg = await screen.findByRole("dialog", { name: "agent/config.xml" })
    fireEvent.click(within(dlg).getByRole("button", { name: "Edit in Configuration" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "agent/config.xml" })).toBeNull())
    expect(onOpenConfig).toHaveBeenCalledTimes(1)
  })

  it("with unsaved changes it asks first: cancel keeps the editor, confirm closes and switches tab", async () => {
    const { onOpenConfig } = await setup()
    await expandAgent()
    fireEvent.click(row(/^config\.xml/))
    const dlg = await screen.findByRole("dialog", { name: "agent/config.xml" })
    fireEvent.change(await within(dlg).findByRole("textbox", { name: "editor" }), { target: { value: "edited" } })
    fireEvent.click(within(dlg).getByRole("button", { name: "Edit in Configuration" }))
    let confirm = await screen.findByRole("dialog", { name: "Close Without Saving?" })
    fireEvent.click(within(confirm).getAllByRole("button")[0]) // Cancel
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Close Without Saving?" })).toBeNull())
    expect(onOpenConfig).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "agent/config.xml" })).toBeTruthy()

    fireEvent.click(within(dlg).getByRole("button", { name: "Edit in Configuration" }))
    confirm = await screen.findByRole("dialog", { name: "Close Without Saving?" })
    fireEvent.click(within(confirm).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "agent/config.xml" })).toBeNull())
    expect(onOpenConfig).toHaveBeenCalledTimes(1)
  })

  it("a non-config file's editor has no Edit in Configuration", async () => {
    await setup()
    const { dlg } = await openNotes()
    expect(within(dlg).queryByRole("button", { name: "Edit in Configuration" })).toBeNull()
  })
})

describe("FilesTab row menu", () => {
  const menuItems = () => within(screen.getByRole("menu")).queryAllByRole("menuitem").map((m) => m.textContent)

  it("right-click: secret files have no Open/Download, locked entries no Rename/Delete, config files link to Configuration", async () => {
    const { container, onOpenConfig } = await setup()
    await expandAgent()
    fireEvent.contextMenu(container.querySelector('[data-row="agent/secret.key"]')!)
    expect(menuItems()).toEqual(["Rename", "Delete"])
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()

    fireEvent.contextMenu(container.querySelector('[data-row="agent/config.xml"]')!)
    expect(menuItems()).toEqual(["Open", "Download", "Edit in Configuration"])
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Edit in Configuration" }))
    expect(onOpenConfig).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("menu")).toBeNull()

    // clicking a secret file opens nothing
    fireEvent.click(row("secret.key"))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.some((c) => c.content)).toBe(false)
  })

  it("the ⋯ button opens the same menu; an outside press closes it", async () => {
    await setup()
    fireEvent.click(screen.getByRole("button", { name: "More Actions: notes.txt" }))
    expect(menuItems()).toEqual(["Open", "Download", "Rename", "Delete"])
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Download" }).getAttribute("href"))
      .toBe("/midhub/api/mids/m1/files/download?path=notes.txt")
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("Rename and Delete send the existing requests", async () => {
    await setup()
    fireEvent.click(screen.getByRole("button", { name: "More Actions: notes.txt" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    const dlg = await screen.findByRole("dialog", { name: "Rename notes.txt" })
    const input = within(dlg).getByRole("textbox", { name: "Name" })
    fireEvent.change(input, { target: { value: "a/b" } })
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirm" }))
    expect(within(dlg).getByText(/ชื่อไฟล์\/โฟลเดอร์ใช้/)).toBeTruthy()
    expect(sent("POST")).toHaveLength(0)
    fireEvent.change(input, { target: { value: "n2.txt" } })
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(sent("POST").map((c) => c.body)).toEqual([{ op: "rename", path: "notes.txt", newName: "n2.txt" }]))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "More Actions: notes.txt" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    const confirm = await screen.findByRole("dialog", { name: "Delete notes.txt?" })
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(sent("DELETE").map((c) => c.path)).toEqual(["notes.txt"]))
  })
})

describe("FilesTab create and upload", () => {
  it("New File creates an empty file in the selected folder and opens it", async () => {
    await setup()
    await expandAgent()
    fireEvent.click(row("extlib"))
    await screen.findByRole("button", { name: "a.jar" })
    expect(screen.getByRole("navigation", { name: "Upload Target" }).textContent).toBe("m1/agent/extlib")
    fireEvent.click(screen.getByRole("button", { name: "New File" }))
    const dlg = await screen.findByRole("dialog", { name: "New File" })
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Name" }), { target: { value: "a.txt" } })
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirm" }))
    await screen.findByRole("dialog", { name: "agent/extlib/a.txt" })
    expect(sent("PUT").map((c) => c.body)).toEqual([{ path: "agent/extlib/a.txt", content: "", baseHash: "" }])
  })

  it("New Folder sends mkdir under the selected folder", async () => {
    await setup()
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }))
    const dlg = await screen.findByRole("dialog", { name: "New Folder" })
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Name" }), { target: { value: "d1" } })
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(sent("POST").map((c) => c.body)).toEqual([{ op: "mkdir", parent: "", name: "d1" }]))
  })

  class FakeXHR {
    static all: FakeXHR[] = []
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    ontimeout: (() => void) | null = null
    status = 0
    responseText = ""
    url = ""
    body: FormData | null = null
    open(_m: string, url: string) { this.url = url }
    send(b: FormData) { this.body = b; FakeXHR.all.push(this) }
    getResponseHeader() { return "application/json" }
    respond(status: number, text: string) { this.status = status; this.responseText = text; this.onload?.() }
  }
  beforeEach(() => { FakeXHR.all = []; vi.stubGlobal("XMLHttpRequest", FakeXHR) })

  const file = (name: string, size = 3) => {
    const f = new File(["abc"], name)
    if (size !== 3) Object.defineProperty(f, "size", { value: size })
    return f
  }
  const drop = (el: Element, files: File[]) => {
    fireEvent.dragOver(el, { dataTransfer: { files, types: ["Files"] } })
    fireEvent.drop(el, { dataTransfer: { files, types: ["Files"] } })
  }
  const card = () => screen.getByTestId("files-card")

  it("a file over 50 MB shows the size error and sends nothing", async () => {
    await setup()
    drop(card(), [file("big.bin", 51 * 1024 * 1024)])
    expect((await screen.findByRole("alert")).textContent).toContain("50 MB")
    expect(FakeXHR.all).toHaveLength(0)
    expect(sent("POST")).toHaveLength(0)
  })

  it("an existing name asks before overwriting", async () => {
    await setup()
    drop(card(), [file("notes.txt")])
    const confirm = await screen.findByRole("dialog", { name: "Overwrite notes.txt?" })
    expect(FakeXHR.all).toHaveLength(0)
    fireEvent.click(within(confirm).getByRole("button", { name: "Overwrite" }))
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1))
  })

  it("two files dropped on a folder upload one after the other with a progress bar", async () => {
    await setup()
    await expandAgent()
    fireEvent.click(row("extlib"))
    await screen.findByRole("button", { name: "a.jar" })
    const target = document.querySelector('[data-row="agent/extlib"]')!
    drop(target, [file("one.jar"), file("two.jar")])
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1))
    const first = FakeXHR.all[0]
    expect(first.url).toBe("/midhub/api/mids/m1/files")
    expect(first.body?.get("dir")).toBe("agent/extlib")
    expect((first.body?.get("file") as File).name).toBe("one.jar")
    first.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    const bar = await screen.findByRole("progressbar")
    await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("50"))
    expect(FakeXHR.all).toHaveLength(1) // the second waits for the first
    first.respond(200, '{"size":3}')
    await waitFor(() => expect(FakeXHR.all).toHaveLength(2))
    expect((FakeXHR.all[1].body?.get("file") as File).name).toBe("two.jar")
    FakeXHR.all[1].respond(200, '{"size":3}')
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull())
  })

  it("uploads are refused while a lifecycle job runs", async () => {
    await setup({ busyReason: "กำลังอัปเกรด MID" })
    drop(card(), [file("one.jar")])
    expect((await screen.findByRole("alert")).textContent).toContain("กำลังอัปเกรด MID")
    expect(FakeXHR.all).toHaveLength(0)
  })
})

describe("FilesTab multi-select", () => {
  const ctrl = { ctrlKey: true }
  const rowEl = (container: HTMLElement, path: string) => container.querySelector(`[data-row="${path}"]`) as HTMLElement
  const rowBtn = (container: HTMLElement, path: string) => rowEl(container, path).querySelector("button") as HTMLButtonElement
  /** Expand agent/extlib with four jars; the focus is on a.jar. */
  async function inExtlib() {
    FS["agent/extlib"].entries = ["a.jar", "b.jar", "c.jar", "d.jar"].map((n) => E(n, "file"))
    const r = await setup()
    await expandAgent()
    fireEvent.click(row("extlib"))
    await screen.findByRole("button", { name: "a.jar" })
    calls.length = 0
    return r
  }
  const bar = () => screen.queryByText(/^เลือก \d+ รายการ$/)

  it("Ctrl+click toggles rows without opening an editor; the bar shows from 2 rows; Esc clears", async () => {
    const { container } = await inExtlib()
    fireEvent.click(row("a.jar"), ctrl)
    expect(bar()).toBeNull()
    fireEvent.click(row("c.jar"), ctrl)
    expect(screen.getByText("เลือก 2 รายการ")).toBeTruthy()
    expect(rowEl(container, "agent/extlib/a.jar").getAttribute("aria-selected")).toBe("true")
    expect(rowEl(container, "agent/extlib/b.jar").getAttribute("aria-selected")).toBe("false")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(calls.some((c) => c.content)).toBe(false)
    rowBtn(container, "agent/extlib/c.jar").focus()
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    expect(bar()).toBeNull()
    expect(rowEl(container, "agent/extlib/a.jar").getAttribute("aria-selected")).toBe("false")
  })

  it("Shift+click selects the range in display order; Ctrl+click in another folder starts over", async () => {
    await inExtlib()
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("c.jar"), { shiftKey: true })
    expect(screen.getByText("เลือก 3 รายการ")).toBeTruthy()
    fireEvent.click(row("notes.txt"), ctrl)
    expect(bar()).toBeNull()
  })

  it("a plain click still opens the file", async () => {
    await inExtlib()
    fireEvent.click(row("a.jar"))
    await screen.findByRole("dialog", { name: "agent/extlib/a.jar" })
  })

  it("Delete in the bar confirms, deletes in order and reloads the folder", async () => {
    await inExtlib()
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    const dlg = await screen.findByRole("dialog", { name: "Delete 2 Items?" })
    fireEvent.click(within(dlg).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(listed("agent/extlib")).toBe(true))
    expect(sent("DELETE").map((c) => c.path)).toEqual(["agent/extlib/a.jar", "agent/extlib/b.jar"])
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("a refused delete stops the batch and reports the progress with the server message", async () => {
    await inExtlib()
    deleteReply = (p) => p === "agent/extlib/b.jar" ? Response.json({ code: "protected", message: "ลบไม่ได้: ไฟล์ถูกป้องกัน" }, { status: 403 }) : Response.json({})
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("c.jar"), { shiftKey: true })
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    const dlg = await screen.findByRole("dialog", { name: "Delete 3 Items?" })
    fireEvent.click(within(dlg).getByRole("button", { name: "Delete" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("ลบแล้ว 1 จาก 3 รายการ")
    expect(alert.textContent).toContain("ลบไม่ได้: ไฟล์ถูกป้องกัน")
    expect(sent("DELETE").map((c) => c.path)).toEqual(["agent/extlib/a.jar", "agent/extlib/b.jar"])
  })

  it("bar Delete is disabled with a reason for a locked entry or while a job runs", async () => {
    await setup()
    await expandAgent()
    fireEvent.click(row(/^x\.xml/), { ...ctrl })
    fireEvent.click(row(/^config\.xml/), ctrl)
    const del = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement
    expect(del.disabled).toBe(true)
    expect(screen.getByText(/ลบไม่ได้/)).toBeTruthy()
    cleanup()

    FS["agent/extlib"].entries = [E("a.jar", "file"), E("b.jar", "file")]
    await setup({ busyReason: "กำลังรีสตาร์ต MID" })
    await expandAgent()
    fireEvent.click(row("extlib"))
    await screen.findByRole("button", { name: "a.jar" })
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText(/กำลังรีสตาร์ต MID/).length).toBeGreaterThan(1)
  })

  it("Download .zip checks first; a 413 shows the message and does not navigate", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    await inExtlib()
    zipReply = () => Response.json({ code: "too_large", message: "ใหญ่เกิน 1 GB" }, { status: 413 })
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    fireEvent.click(screen.getByRole("button", { name: "Download .zip" }))
    expect((await screen.findByRole("alert")).textContent).toContain("ใหญ่เกิน 1 GB")
    expect(zipUrls).toEqual(["/mids/m1/files/zip?dir=agent%2Fextlib&name=a.jar&name=b.jar&check=1"])
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it("Download .zip navigates to the zip URL after a successful check", async () => {
    const hrefs: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { hrefs.push(`${this.getAttribute("href")}|${this.download}`) })
    await inExtlib()
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    fireEvent.click(screen.getByRole("button", { name: "Download .zip" }))
    await waitFor(() => expect(hrefs).toHaveLength(1))
    expect(hrefs[0]).toBe("/midhub/api/mids/m1/files/zip?dir=agent%2Fextlib&name=a.jar&name=b.jar|extlib.zip")
    click.mockRestore()
  })

  it("only folder rows offer Download .zip in the menu, and it zips that folder", async () => {
    const hrefs: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { hrefs.push(`${this.getAttribute("href")}|${this.download}`) })
    await setup()
    fireEvent.click(screen.getByRole("button", { name: "More Actions: notes.txt" }))
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Download .zip" })).toBeNull()
    fireEvent.keyDown(document, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "More Actions: agent" }))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Download .zip" }))
    await waitFor(() => expect(hrefs).toHaveLength(1))
    expect(hrefs[0]).toBe("/midhub/api/mids/m1/files/zip?dir=&name=agent|agent.zip")
    click.mockRestore()
  })

  it("Del opens the delete confirm for the selection", async () => {
    const { container } = await inExtlib()
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    rowBtn(container, "agent/extlib/b.jar").focus()
    fireEvent.keyDown(document.activeElement!, { key: "Delete" })
    await screen.findByRole("dialog", { name: "Delete 2 Items?" })
  })

  it("F2 renames one unlocked row; nothing for a locked row or two selected", async () => {
    const { container } = await inExtlib()
    rowBtn(container, "agent/extlib/b.jar").focus()
    fireEvent.keyDown(document.activeElement!, { key: "F2" })
    await screen.findByRole("dialog", { name: "Rename b.jar" })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    rowBtn(container, "agent/extlib/b.jar").focus()
    fireEvent.keyDown(document.activeElement!, { key: "F2" })
    expect(screen.queryByRole("dialog")).toBeNull()

    rowBtn(container, "agent/config.xml").focus()
    fireEvent.keyDown(document.activeElement!, { key: "F2" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("Enter on a focused row is a plain click; Ctrl+A selects the focused row's siblings", async () => {
    const { container } = await inExtlib()
    rowBtn(container, "agent/extlib/b.jar").focus()
    fireEvent.keyDown(document.activeElement!, { key: "a", ctrlKey: true })
    expect(screen.getByText("เลือก 4 รายการ")).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: "Enter" })
    await screen.findByRole("dialog", { name: "agent/extlib/b.jar" })
    expect(bar()).toBeNull()
  })

  it("keys typed in the name dialog do nothing to the tree", async () => {
    const { container } = await inExtlib()
    fireEvent.click(row("a.jar"), ctrl)
    fireEvent.click(row("b.jar"), ctrl)
    rowBtn(container, "agent/extlib/b.jar").focus()
    fireEvent.click(screen.getByRole("button", { name: "New File" }))
    const dlg = await screen.findByRole("dialog", { name: "New File" })
    const input = within(dlg).getByRole("textbox", { name: "Name" })
    fireEvent.keyDown(input, { key: "Delete" })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "Delete 2 Items?" })).toBeNull()
    expect(screen.getByText("เลือก 2 รายการ")).toBeTruthy()
  })
})
