import { afterEach, describe, expect, it, vi } from "vitest"
import { addrsForHost, deps, listenerOwnerProblem, listenerUids, serviceUid, uidFromPasswd } from "./listener-owner"

// Rows copied in the exact layout of this host's /proc/net/tcp and /proc/net/tcp6 (0BB8 = port 3000).
const TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 7810 1 0000000000000000 100 0 0 10 0",
  "   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 15371 2 0000000000000000 100 0 0 10 0",
  "   2: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1009        0 15372 2 0000000000000000 100 0 0 10 0",
  // ESTABLISHED (01) to :3000 from a client socket owned by someone else: not a listener, ignored.
  "   3: 0100007F:0BB8 0100007F:D2F4 01 00000000:00000000 00:00000000 00000000  1002        0 15373 1 0000000000000000 20 4 30 10 -1",
  // A listener on another port (0C1C = 3100), ignored.
  "   4: 0100007F:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 15374 1 0000000000000000 100 0 0 10 0",
  // A listener on a LAN address on :3000: not loopback/wildcard, so not what MidHub connects to.
  "   5: 8E96040A:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1010        0 15375 1 0000000000000000 100 0 0 10 0",
].join("\n")

const TCP6 = [
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 46994322 2 0000000000000000 100 0 0 10 0",
  "   1: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1011        0 46994323 2 0000000000000000 100 0 0 10 0",
  // v4-mapped ::ffff:127.0.0.1 and ::ffff:0.0.0.0
  "   2: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1012        0 46994324 2 0000000000000000 100 0 0 10 0",
  "   3: 0000000000000000FFFF000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1013        0 46994325 2 0000000000000000 100 0 0 10 0",
  // non-LISTEN (06 = TIME_WAIT) and another port: ignored
  "   4: 00000000000000000000000001000000:0BB8 00000000000000000000000001000000:9C40 06 00000000:00000000 03:00000F9A 00000000     0        0 0 3 0000000000000000",
  "   5: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 46994326 2 0000000000000000 100 0 0 10 0",
].join("\n")

const set = (...a: string[]) => new Set(a)

describe("listenerUids", () => {
  it("v4 wildcard listener (00000000:0BB8)", () => {
    expect(listenerUids(TCP, 3000, set("0.0.0.0"))).toEqual([1003])
  })
  it("v4 127.0.0.1 listener (0100007F:0BB8); the ESTABLISHED row on the same address is ignored", () => {
    expect(listenerUids(TCP, 3000, set("127.0.0.1"))).toEqual([1009])
  })
  it("v6 wildcard listener (::)", () => {
    expect(listenerUids(TCP6, 3000, set("::"))).toEqual([1003])
  })
  it("v6 loopback ::1", () => {
    expect(listenerUids(TCP6, 3000, set("::1"))).toEqual([1011])
  })
  it("v4-mapped forms count as their v4 address", () => {
    expect(listenerUids(TCP6, 3000, set("127.0.0.1"))).toEqual([1012])
    expect(listenerUids(TCP6, 3000, set("0.0.0.0"))).toEqual([1013])
  })
  it("non-LISTEN rows are ignored", () => {
    // Only the TIME_WAIT row would match ::1 if state were not checked; the LISTEN ::1 row is uid 1011.
    expect(listenerUids(TCP6, 3000, set("::1"))).not.toContain(0)
  })
  it("a different port is ignored", () => {
    expect(listenerUids(TCP, 3100, set("0.0.0.0"))).toEqual([])
    expect(listenerUids(TCP, 3001, set("0.0.0.0", "127.0.0.1"))).toEqual([])
    expect(listenerUids(TCP6, 80, set("::"))).toEqual([999])
  })
  it("the URL's address set: 127.0.0.1 plus wildcards; a LAN-address listener is not counted", () => {
    expect(listenerUids(TCP, 3000, addrsForHost("127.0.0.1")).sort()).toEqual([1003, 1009])
    expect(listenerUids(TCP6, 3000, addrsForHost("127.0.0.1")).sort()).toEqual([1003, 1012, 1013])
  })
  it("empty or garbage input yields nothing", () => {
    expect(listenerUids("", 3000, set("0.0.0.0"))).toEqual([])
    expect(listenerUids("junk line\n   0: zz:0BB8 x 0A", 3000, set("0.0.0.0"))).toEqual([])
  })
})

describe("addrsForHost", () => {
  it("maps each allowed AGENTHUB_URL host to the local addresses that would accept its connection", () => {
    expect(addrsForHost("127.0.0.1")).toEqual(set("127.0.0.1", "0.0.0.0", "::"))
    expect(addrsForHost("[::1]")).toEqual(set("::1", "::"))
    expect(addrsForHost("localhost")).toEqual(set("127.0.0.1", "::1", "0.0.0.0", "::"))
  })
})

describe("uidFromPasswd", () => {
  const PASSWD = "root:x:0:0:root:/root:/bin/bash\nbsmagenthub:x:1003:1003::/home/bsmagenthub:/bin/bash\n#comment\nbad-line\n"
  it("finds the uid by exact name", () => {
    expect(uidFromPasswd(PASSWD, "bsmagenthub")).toBe(1003)
    expect(uidFromPasswd(PASSWD, "root")).toBe(0)
  })
  it("no such user (or only a prefix match) -> null", () => {
    expect(uidFromPasswd(PASSWD, "bsmagent")).toBeNull()
    expect(uidFromPasswd(PASSWD, "nobody")).toBeNull()
  })
})

describe("serviceUid / listenerOwnerProblem (injected reader)", () => {
  const saved = deps.readFile
  afterEach(() => {
    deps.readFile = saved
  })
  const fake = (files: Record<string, string>) => {
    const reader = vi.fn(async (p: string) => {
      if (p in files) return files[p]
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
    })
    deps.readFile = reader
    return reader
  }
  const PASSWD = "ahsvc1:x:1003:1003::/h:/bin/sh\nahsvc2:x:1003:1003::/h:/bin/sh\nahsvc3:x:1003:1003::/h:/bin/sh\nahsvc4:x:1003:1003::/h:/bin/sh\nahsvc5:x:1003:1003::/h:/bin/sh\n"

  it("resolves the uid from /etc/passwd once per process (cached)", async () => {
    const r = fake({ "/etc/passwd": PASSWD })
    expect(await serviceUid("ahsvc1")).toBe(1003)
    expect(await serviceUid("ahsvc1")).toBe(1003)
    expect(r.mock.calls.filter(([p]) => p === "/etc/passwd")).toHaveLength(1)
  })

  it("an unknown user is a configuration error (throws, naming AGENTHUB_SERVICE_USER), not unreachable", async () => {
    fake({ "/etc/passwd": PASSWD })
    await expect(serviceUid("nosuchuser")).rejects.toThrow(/AGENTHUB_SERVICE_USER.*nosuchuser/)
    await expect(listenerOwnerProblem("http://127.0.0.1:3000", "nosuchuser")).rejects.toThrow(/AGENTHUB_SERVICE_USER/)
  })

  it("every matching listener owned by the service user -> null (ok)", async () => {
    fake({ "/etc/passwd": PASSWD, "/proc/net/tcp": TCP.split("\n").filter((l) => !l.includes("0100007F:0BB8 00000000")).join("\n"), "/proc/net/tcp6": "" })
    expect(await listenerOwnerProblem("http://127.0.0.1:3000", "ahsvc2")).toBeNull()
  })

  it("one matching listener owned by someone else -> problem naming the port, user and uid", async () => {
    fake({ "/etc/passwd": PASSWD, "/proc/net/tcp": TCP, "/proc/net/tcp6": "" })
    const p = await listenerOwnerProblem("http://127.0.0.1:3000", "ahsvc3")
    expect(p).toMatch(/listener on :3000 not owned by ahsvc3/)
    expect(p).toMatch(/1009/)
  })

  it("nothing listening -> problem; a missing /proc/net/tcp6 (IPv6 off) is treated as empty", async () => {
    fake({ "/etc/passwd": PASSWD, "/proc/net/tcp": TCP })
    expect(await listenerOwnerProblem("http://127.0.0.1:4000", "ahsvc4")).toMatch(/listener on :4000 not owned by ahsvc4 \(nothing listening\)/)
  })

  it("an unreadable /proc/net/tcp fails closed (problem, not ok)", async () => {
    fake({ "/etc/passwd": PASSWD })
    expect(await listenerOwnerProblem("http://127.0.0.1:3000", "ahsvc5")).toMatch(/listener on :3000 not owned by ahsvc5 \(cannot read \/proc\/net\/tcp/)
  })
})
