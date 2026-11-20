import { expect, it } from "vitest"
import { actionLabel, detailPairs } from "./audit-format"

it("labels admin and MID actions in Thai, unknown actions fall back to the raw name", () => {
  expect(actionLabel("user.create")).toBe("Add User")
  expect(actionLabel("ip_allowlist.remove")).toBe("Delete IP Allowlist Entry")
  expect(actionLabel("idp.update")).toBe("Edit SSO Settings")
  expect(actionLabel("mid.fix_ownership")).toBe("Repair Permissions")
  expect(actionLabel("x.y")).toBeNull()
})

it("renders detail as readable Thai key: value pairs (Q-I3)", () => {
  expect(detailPairs(JSON.stringify({ path: "agent/extlib/a.jar", size: 2048 }))).toEqual([["Path", "agent/extlib/a.jar"], ["Size", "2.0 KB"]])
  expect(detailPairs(JSON.stringify({ targetEmail: "m@x.com", role: "admin", passwordChanged: true }))).toEqual([
    ["User", "m@x.com"], ["Role", "Administrator"], ["Password Changed", "Yes"],
  ])
  expect(detailPairs(JSON.stringify({ ok: false, code: "quota_full" }))).toEqual([["Result", "Failed"], ["Error Code", "quota_full"]])
  expect(detailPairs(JSON.stringify({ weird: { a: 1 } }))).toEqual([["weird", '{"a":1}']])
})

it("empty or non-JSON detail", () => {
  expect(detailPairs("{}")).toEqual([])
  expect(detailPairs("not json")).toBeNull()
})

it("labels AgentHub actions in Thai (spec §7)", () => {
  for (const a of ["agent.file.write", "agent.file.upload", "agent.file.mkdir", "agent.file.rename", "agent.file.delete", "agent.restart", "agent.check_failed"]) {
    expect(actionLabel(a), a).toMatch(/AgentHub/)
  }
  expect(actionLabel("agent.file.upload")).toBe("AgentHub Upload File")
  expect(actionLabel("agent.check_failed")).toBe("AgentHub Denied (Check Failed)")
})

it("shows via: agenthub and the taskId first in the detail pairs", () => {
  const d = JSON.stringify({ path: "agent/extlib/a.jar", via: "agenthub", taskId: "task-9", sessionInstances: ["https://a.service-now.com/", "https://b.service-now.com/"], size: 10 })
  expect(detailPairs(d)).toEqual([
    ["Via", "agenthub"],
    ["Task (AgentHub)", "task-9"],
    ["Path", "agent/extlib/a.jar"],
    ["Session Instances", "https://a.service-now.com/, https://b.service-now.com/"],
    ["Size", "10 B"],
  ])
  expect(detailPairs(JSON.stringify({ via: "agenthub", taskId: "t", failed: ["agent_access", "mid_ready"] }))).toEqual([
    ["Via", "agenthub"], ["Task (AgentHub)", "t"], ["Failed Checks", "agent_access, mid_ready"],
  ])
})

it("labels sign-in via AgentHub, denials and lock/unlock (AgentHub SSO)", () => {
  expect(actionLabel("auth.login")).toBe("Sign In (AgentHub)")
  expect(actionLabel("auth.denied")).toBe("Access Denied")
  expect(detailPairs(JSON.stringify({ via: "agenthub" }))).toEqual([["Via", "agenthub"]])
  expect(detailPairs(JSON.stringify({ reason: "not_admin" }))).toEqual([["Reason", "ไม่ใช่ admin ของ AgentHub"]])
  expect(detailPairs(JSON.stringify({ targetEmail: "m@x.com", lock: true }))).toEqual([["User", "m@x.com"], ["Lock", "Yes"]])
})

it("labels user.created (agent call created a MidHub admin) and its email detail", () => {
  expect(actionLabel("user.created")).toBe("Create User (AgentHub Admin)")
  expect(detailPairs(JSON.stringify({ via: "agenthub", email: "new@x.com" }))).toEqual([["Via", "agenthub"], ["Email", "new@x.com"]])
})

it("labels the destination of a move as Moved To, not Renamed To", () => {
  const d = JSON.stringify({ path: "work/a.txt", to: "work/archive/a.txt" })
  expect(detailPairs(d, "file.move")).toEqual([["Path", "work/a.txt"], ["Moved To", "work/archive/a.txt"]])
  expect(detailPairs(JSON.stringify({ path: "work/a.txt", to: "work/b.txt" }), "file.rename")).toEqual([["Path", "work/a.txt"], ["Renamed To", "work/b.txt"]])
})
