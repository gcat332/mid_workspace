import { describe, expect, it } from "vitest"
import { renderUnit } from "./unit-template"

describe("renderUnit", () => {
  const out = renderUnit({ name: "dev-mid", heapMb: 1024, midRoot: "/opt/midhub/mids/dev-mid" })
  it("renders limits and identities", () => {
    expect(out).toContain("MemoryMax=1536M")
    expect(out).toContain("User=midsvc")
    expect(out).toContain("Group=midhub")
    expect(out).toMatch(/^Restart=always$/m)
    expect(out).toMatch(/^RestartSec=10$/m)
    expect(out).toContain("NoNewPrivileges=yes")
    expect(out).toContain("PrivateTmp=yes")
    expect(out).toContain("WantedBy=multi-user.target")
    expect(out).toContain("ExecStart=/opt/midhub/mids/dev-mid/agent/bin/mid.sh console")
    expect(out).toContain("WorkingDirectory=/opt/midhub/mids/dev-mid/agent")
  })
  it("crash loops still hit the start limit (5 starts in 10 min) in [Unit]", () => {
    const unitSection = out.slice(out.indexOf("[Unit]"), out.indexOf("[Service]"))
    expect(unitSection).toMatch(/^StartLimitIntervalSec=600$/m)
    expect(unitSection).toMatch(/^StartLimitBurst=5$/m)
  })
  it("UMask=0002 so files the MID creates stay group-writable for the app (I4)", () => {
    expect(out).toMatch(/^UMask=0002$/m)
  })
  it("injects the name only into paths under midRoot", () => {
    for (const line of out.split("\n").filter((l) => l.includes("dev-mid"))) {
      expect(line).toMatch(/=\/opt\/midhub\/mids\/dev-mid\//)
    }
  })
  it("rejects bad heap and unsafe midRoot", () => {
    expect(() => renderUnit({ name: "a", heapMb: 100, midRoot: "/x" })).toThrow()
    expect(() => renderUnit({ name: "a", heapMb: 1024.5, midRoot: "/x" })).toThrow()
    expect(() => renderUnit({ name: "a", heapMb: 1024, midRoot: "/x\nExecStartPre=/bin/evil" })).toThrow()
  })
})
