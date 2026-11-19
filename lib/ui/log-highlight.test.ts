import { describe, expect, it } from "vitest"
import { tokenizeLogLine, type LogToken } from "./log-highlight"

const kinds = (t: LogToken[]) => t.map((x) => x.kind)
const joined = (t: LogToken[]) => t.map((x) => x.text).join("")
const find = (t: LogToken[], kind: string) => t.find((x) => x.kind === kind)

describe("tokenizeLogLine", () => {
  it("colours an agent log line", () => {
    const line = "2026-11-19T13:37:38.840+0700 INFO  (Worker-Interactive:HeartbeatProbe-14b9) [AWorker:190] Worker starting: HeartbeatProbe"
    const t = tokenizeLogLine(line)
    expect(joined(t)).toBe(line)
    const k = kinds(t)
    expect(k.indexOf("time")).toBeLessThan(k.indexOf("level-info"))
    expect(k.indexOf("level-info")).toBeLessThan(k.indexOf("thread"))
    expect(k.indexOf("thread")).toBeLessThan(k.indexOf("class"))
  })

  it("maps level words", () => {
    expect(kinds(tokenizeLogLine("x ERROR y"))).toContain("level-error")
    expect(kinds(tokenizeLogLine("x SEVERE y"))).toContain("level-error")
    expect(kinds(tokenizeLogLine("x WARNING y"))).toContain("level-warn")
    expect(kinds(tokenizeLogLine("x WARN y"))).toContain("level-warn")
    expect(kinds(tokenizeLogLine("x DEBUG y"))).toContain("level-debug")
    expect(kinds(tokenizeLogLine("ERRORS NOWARNING"))).not.toContain("level-error")
  })

  it("finds paths, URLs, strings and numbers", () => {
    expect(find(tokenizeLogLine("at /opt/midhub/mids/spike1/agent/work/x.xml done"), "path")?.text).toBe("/opt/midhub/mids/spike1/agent/work/x.xml")
    expect(find(tokenizeLogLine("GET https://a.service-now.com/x ok"), "path")?.text).toBe("https://a.service-now.com/x")
    expect(find(tokenizeLogLine('name "quoted" here'), "string")?.text).toBe('"quoted"')
    expect(find(tokenizeLogLine("heap 910.0mb"), "number")?.text).toBe("910.0")
  })

  it("handles a wrapper.log line", () => {
    const line = "INFO   | jvm 1    | 2026/11/19 13:00:00 | started"
    const t = tokenizeLogLine(line)
    expect(joined(t)).toBe(line)
    expect(find(t, "time")?.text).toBe("2026/11/19 13:00:00")
    expect(kinds(t)).toContain("level-info")
  })

  it("never throws and always round-trips", () => {
    for (const line of ["\tat com.x.Y.z(Y.java:12)", "", "(", "[", '"unterminated', "////", "ERROR", "  ", "日本語 ERROR ไทย"]) {
      expect(joined(tokenizeLogLine(line))).toBe(line)
    }
    expect(kinds(tokenizeLogLine("\tat com.x.Y.z(Y.java:12)"))).not.toContain("thread")
  })
})
