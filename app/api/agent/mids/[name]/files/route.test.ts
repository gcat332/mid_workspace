import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const SECRET = "Qv3-files-route-agent-secret-" + "s".repeat(20)
vi.mock("@/lib/env", () => ({ env: { agentSecret: "Qv3-files-route-agent-secret-" + "s".repeat(20) } }))
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ lockedAt: null }),
      upsert: async () => ({ id: "u1", email: "alice@x.com" }),
    },
    ipAllowlist: { findMany: async () => [] },
  },
}))
const audit = vi.hoisted(() => vi.fn(async (...a: unknown[]) => void a))
vi.mock("@/lib/audit", () => ({ recordAudit: audit }))
const A = "https://a.service-now.com/"
const reg = vi.hoisted(() => ({ agentAccess: true, getMid: vi.fn() }))
vi.mock("@/lib/mids/registry", async () => {
  const { MidError } = await import("@/lib/mids/names")
  reg.getMid.mockImplementation(async (name: string) => {
    if (name !== "m1") throw new MidError("not_found")
    return {
      name, instanceUrl: "https://a.service-now.com/", configUrl: "https://a.service-now.com/", midName: "sn", heapMb: 1, version: null,
      state: "installed", agentAccess: reg.agentAccess, status: { state: "running", pid: 1, memoryBytes: 1, since: null }, job: null,
    }
  })
  return { getMid: reg.getMid }
})

import { DELETE, GET, POST, PUT } from "./route"

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const H: Record<string, string> = {
  host: "127.0.0.1:3100",
  "x-midhub-agent-secret": SECRET,
  "x-midhub-actor-email": "alice@x.com",
  "x-midhub-actor-role": "admin",
  "x-midhub-session-id": "task-9",
  "x-midhub-session-instances": A,
}
const ctx = (name = "m1") => ({ params: Promise.resolve({ name }) })
const url = (qs = "", name = "m1") => `http://127.0.0.1:3100/midhub/api/agent/mids/${name}/files${qs}`
const json = (method: string, body: unknown, qs = "") =>
  new Request(url(qs), { method, headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) })
const raw = (qs: string, chunks: string[], headers: Record<string, string> = {}) =>
  new Request(url(qs), {
    method: "POST",
    headers: { ...H, "content-type": "application/octet-stream", ...headers },
    body: new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(Buffer.from(x)); c.close() } }),
    duplex: "half",
  } as RequestInit)
const get = (qs: string, name = "m1") => new Request(url(qs, name), { headers: H })

let root: string
let m: string
/** Every path + content under the MID, to prove a refused request changed nothing. */
function snapshot(): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n)
      const st = fs.lstatSync(p)
      out.push(path.relative(m, p) + (st.isFile() ? `=${fs.readFileSync(p, "utf8")}` : ""))
      if (st.isDirectory()) walk(p)
    }
  }
  walk(m)
  return out.join("\n")
}
const auditCalls = () => audit.mock.calls.map((c) => c[1])

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midhub-agent-files-"))
  process.env.MIDHUB_ROOT = root
  m = path.join(root, "mids", "m1")
  for (const d of ["agent/bin", "agent/lib", "agent/jre", "agent/conf", "agent/extlib", "work"]) fs.mkdirSync(path.join(m, d), { recursive: true })
  fs.writeFileSync(path.join(m, "agent/config.xml"), "<parameters/>")
  fs.writeFileSync(path.join(m, "agent/bin/mid.sh"), "#!/bin/sh\n")
  fs.writeFileSync(path.join(m, "work/note.txt"), "hello")
  reg.agentAccess = true
  audit.mockClear()
  reg.getMid.mockClear()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.MIDHUB_ROOT
})

describe("checklist gate", () => {
  it("agentAccess off -> 403 agent_check_failed with checks for every method; nothing on disk changes", async () => {
    reg.agentAccess = false
    const before = snapshot()
    const reqs: [string, Promise<Response>][] = [
      ["GET list", GET(get("?path=work"), ctx())],
      ["GET content", GET(get("?path=work/note.txt&content=1"), ctx())],
      ["PUT", PUT(json("PUT", { path: "work/note.txt", content: "evil", baseHash: sha("hello") }), ctx())],
      ["PUT new", PUT(json("PUT", { path: "work/new.txt", content: "evil", baseHash: "" }), ctx())],
      ["POST upload", POST(raw("?dir=agent/extlib&filename=x.jar", ["jar"], { "content-length": "3" }), ctx())],
      ["POST mkdir", POST(json("POST", { op: "mkdir", parent: "work", name: "d" }), ctx())],
      ["POST rename", POST(json("POST", { op: "rename", path: "work/note.txt", newName: "n2" }), ctx())],
      ["DELETE", DELETE(new Request(url("?path=work/note.txt"), { method: "DELETE", headers: H }), ctx())],
    ]
    for (const [label, p] of reqs) {
      const res = await p
      expect(res.status, label).toBe(403)
      const b = await res.json()
      expect(b.code, label).toBe("agent_check_failed")
      expect(b.checks.find((c: { id: string }) => c.id === "agent_access").ok, label).toBe(false)
    }
    expect(snapshot()).toBe(before)
    expect(new Set(auditCalls())).toEqual(new Set(["agent.check_failed"]))
  })
  it("invalid MID name -> 400 invalid_name before any lookup", async () => {
    const res = await GET(get("?path=", "Bad_Name"), ctx("Bad_Name"))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_name")
    expect(reg.getMid).not.toHaveBeenCalled()
  })
  it("unauthenticated (wrong secret) -> 401 and no lookup", async () => {
    const res = await GET(new Request(url("?path="), { headers: { ...H, "x-midhub-agent-secret": "nope" } }), ctx())
    expect(res.status).toBe(401)
    expect(reg.getMid).not.toHaveBeenCalled()
  })
})

describe("read", () => {
  it("GET lists a directory like the files tab, and reads text with hash; config.xml is refused", async () => {
    const l = await GET(get("?path=agent"), ctx())
    expect(l.status).toBe(200)
    const lb = await l.json()
    expect(lb.readOnly).toBe(false)
    expect(lb.entries.map((e: { name: string }) => e.name)).toEqual(["bin", "conf", "extlib", "jre", "lib", "config.xml"])
    const c = await GET(get("?path=work/note.txt&content=1"), ctx())
    expect(await c.json()).toEqual({ content: "hello", hash: sha("hello") })
    const x = await GET(get("?path=agent/config.xml&content=1"), ctx())
    expect(x.status).toBe(403)
    expect((await x.json()).code).toBe("use_config_tab")
    expect(audit).not.toHaveBeenCalled()
  })
})

describe("PUT write", () => {
  it("writes text with stale detection, creates with baseHash \"\", audits agent.file.write", async () => {
    const r = await PUT(json("PUT", { path: "work/note.txt", content: "bye", baseHash: sha("hello") }), ctx())
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ hash: sha("bye") })
    expect(fs.readFileSync(path.join(m, "work/note.txt"), "utf8")).toBe("bye")
    const stale = await PUT(json("PUT", { path: "work/note.txt", content: "x", baseHash: sha("hello") }), ctx())
    expect(stale.status).toBe(409)
    expect((await PUT(json("PUT", { path: "agent/extlib/a.properties", content: "k=v", baseHash: "" }), ctx())).status).toBe(200)
    expect(fs.readFileSync(path.join(m, "agent/extlib/a.properties"), "utf8")).toBe("k=v")
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ email: "alice@x.com" }), "agent.file.write", "m1", {
      via: "agenthub", taskId: "task-9", sessionInstances: [A], path: "work/note.txt",
    })
    expect(audit).toHaveBeenCalledWith(expect.anything(), "agent.file.write", "m1", expect.objectContaining({ path: "agent/extlib/a.properties" }))
  })
  it("agent/config.xml -> 403 use_config_tab; into agent/bin -> 403 read_only; bad body -> 400", async () => {
    const before = snapshot()
    const cfg = await PUT(json("PUT", { path: "agent/config.xml", content: "x", baseHash: sha("<parameters/>") }), ctx())
    expect(cfg.status).toBe(403)
    expect((await cfg.json()).code).toBe("use_config_tab")
    const bin = await PUT(json("PUT", { path: "agent/bin/mid.sh", content: "x", baseHash: sha("#!/bin/sh\n") }), ctx())
    expect(bin.status).toBe(403)
    expect((await bin.json()).code).toBe("read_only")
    const binNew = await PUT(json("PUT", { path: "agent/bin/new.sh", content: "x", baseHash: "" }), ctx())
    expect((await binNew.json()).code).toBe("read_only")
    const bad = await PUT(json("PUT", { path: "work/note.txt", content: 1, baseHash: "" }), ctx())
    expect(bad.status).toBe(400)
    expect(snapshot()).toBe(before)
    expect(auditCalls()).not.toContain("agent.file.write")
  })
})

describe("POST raw upload", () => {
  it("happy path streams into agent/extlib and audits path + size, never the secret", async () => {
    const res = await POST(raw("?dir=agent/extlib&filename=driver.jar", ["PK", "\u0003\u0004rest"], { "content-length": "8" }), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size: 8, path: "agent/extlib/driver.jar" })
    expect(fs.readFileSync(path.join(m, "agent/extlib/driver.jar"), "latin1")).toBe("PK\u0003\u0004rest")
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "agent.file.upload", "m1", {
      via: "agenthub", taskId: "task-9", sessionInstances: [A], path: "agent/extlib/driver.jar", size: 8,
    })
    expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET)
  })
  it("declared 51 MiB -> 413 too_large without reading the body; no file", async () => {
    let pulled = false
    const req = new Request(url("?dir=agent/extlib&filename=big.jar"), {
      method: "POST", headers: { ...H, "content-length": String(51 * 1024 * 1024) },
      body: new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.close() } }, { highWaterMark: 0 }), duplex: "half",
    } as RequestInit)
    const res = await POST(req, ctx())
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe("too_large")
    expect(pulled).toBe(false)
    expect(fs.existsSync(path.join(m, "agent/extlib/big.jar"))).toBe(false)
  })
  it("body shorter than Content-Length -> 400 and no file (no temp left)", async () => {
    const res = await POST(raw("?dir=agent/extlib&filename=short.jar", ["abc"], { "content-length": "100" }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
    expect(fs.readdirSync(path.join(m, "agent/extlib"))).toEqual([])
    expect(auditCalls()).not.toContain("agent.file.upload")
  })
  it("missing / non-numeric Content-Length -> 411 length_required", async () => {
    for (const h of [{}, { "content-length": "12abc" }] as Record<string, string>[]) {
      const res = await POST(raw("?dir=work&filename=a", ["x"], h), ctx())
      expect(res.status).toBe(411)
      expect((await res.json()).code).toBe("length_required")
    }
    expect(fs.existsSync(path.join(m, "work/a"))).toBe(false)
  })
  it("into agent/bin -> 403 read_only; config.xml -> use_config_tab", async () => {
    const bin = await POST(raw("?dir=agent/bin&filename=x", ["x"], { "content-length": "1" }), ctx())
    expect((await bin.json()).code).toBe("read_only")
    const cfg = await POST(raw("?dir=agent&filename=config.xml", ["x"], { "content-length": "1" }), ctx())
    expect((await cfg.json()).code).toBe("use_config_tab")
    expect(fs.readFileSync(path.join(m, "agent/config.xml"), "utf8")).toBe("<parameters/>")
  })
})

describe("parallel agent uploads (I1)", () => {
  it("at most 2 at a time: a third gets 429 busy; slots are freed on success and on failure", async () => {
    const gates: Array<() => void> = []
    const held = (name: string) => new Request(url(`?dir=work&filename=${name}`), {
      method: "POST", headers: { ...H, "content-length": "1" }, duplex: "half",
      body: new ReadableStream<Uint8Array>({
        async pull(c) { await new Promise<void>((r) => gates.push(r)); c.enqueue(Buffer.from("x")); c.close() },
      }, { highWaterMark: 0 }),
    } as RequestInit)
    const a = POST(held("a"), ctx())
    const b = POST(held("b"), ctx())
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    const c = await POST(raw("?dir=work&filename=c", ["x"], { "content-length": "1" }), ctx())
    expect(c.status).toBe(429)
    const cb = await c.json()
    expect(cb.code).toBe("busy")
    expect(cb.message).toMatch(/AgentHub.*ลองใหม่/)
    expect(fs.existsSync(path.join(m, "work/c"))).toBe(false)
    gates.forEach((g) => g())
    expect((await a).status).toBe(200)
    expect((await b).status).toBe(200)
    // a failing upload (short body) releases its slot too
    expect((await POST(raw("?dir=work&filename=s", ["x"], { "content-length": "9" }), ctx())).status).toBe(400)
    const d = POST(raw("?dir=work&filename=d", ["x"], { "content-length": "1" }), ctx())
    const e = POST(raw("?dir=work&filename=e", ["x"], { "content-length": "1" }), ctx())
    expect([(await d).status, (await e).status]).toEqual([200, 200])
  })
})

describe("POST JSON ops and DELETE", () => {
  it("mkdir, rename and delete act like the files tab and are audited as agent.file.*", async () => {
    const mk = await POST(json("POST", { op: "mkdir", parent: "work", name: "d" }), ctx())
    expect(mk.status).toBe(200)
    expect(fs.statSync(path.join(m, "work/d")).isDirectory()).toBe(true)
    const rn = await POST(json("POST", { op: "rename", path: "work/note.txt", newName: "n2.txt" }), ctx())
    expect(await rn.json()).toEqual({ to: "work/n2.txt" })
    const del = await DELETE(new Request(url("?path=work/n2.txt"), { method: "DELETE", headers: H }), ctx())
    expect(del.status).toBe(200)
    expect(fs.existsSync(path.join(m, "work/n2.txt"))).toBe(false)
    const base = { via: "agenthub", taskId: "task-9", sessionInstances: [A] }
    expect(audit).toHaveBeenCalledWith(expect.anything(), "agent.file.mkdir", "m1", { ...base, path: "work/d" })
    expect(audit).toHaveBeenCalledWith(expect.anything(), "agent.file.rename", "m1", { ...base, path: "work/note.txt", to: "work/n2.txt" })
    expect(audit).toHaveBeenCalledWith(expect.anything(), "agent.file.delete", "m1", { ...base, path: "work/n2.txt" })
  })
  it("unknown op / bad JSON -> 400; deleting agent/bin -> 403 read_only", async () => {
    expect((await POST(json("POST", { op: "chmod" }), ctx())).status).toBe(400)
    const del = await DELETE(new Request(url("?path=agent/bin"), { method: "DELETE", headers: H }), ctx())
    expect((await del.json()).code).toBe("read_only")
    expect(fs.existsSync(path.join(m, "agent/bin/mid.sh"))).toBe(true)
  })
})
