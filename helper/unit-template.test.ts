import { describe, expect, it } from "vitest"
import { renderUnit } from "./unit-template"

describe("renderUnit", () => {
  const out = renderUnit({ name: "dev-mid", heapMb: 1024, midRoot: "/opt/midhub/mids/dev-mid" })
  it("renders limits and identities", () => {
    expect(out).toContain("MemoryMax=1536M")
    expect(out).toContain("User=midsvc")
    expect(out).toContain("Group=midhub")
    expect(out).toContain("Restart=on-failure")
    expect(out).toContain("WantedBy=multi-user.target")
    expect(out).toContain("ExecStart=/opt/midhub/mids/dev-mid/agent/bin/mid.sh console")
    expect(out).toContain("WorkingDirectory=/opt/midhub/mids/dev-mid/agent")
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
