/** Splits one log line into coloured tokens for the log pane. Pure: the joined token text always equals the input. */

export const LOG_VIEW_LINES = 150

export type LogTokenKind =
  | "plain" | "time" | "level-error" | "level-warn" | "level-info" | "level-debug"
  | "thread" | "class" | "number" | "string" | "path"
export type LogToken = { text: string; kind: LogTokenKind }

// Alternatives are tried in this order at each position; the earliest match in the line wins.
const GROUPS: [LogTokenKind, string][] = [
  ["time", String.raw`\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?`],
  ["string", String.raw`"[^"\n]*"`],
  ["path", String.raw`https?:\/\/[^\s"'<>)\]]+|(?<![\w.])(?:\/[\w.@~-]+){2,}\/?`],
  ["level-error", String.raw`\b(?:ERROR|SEVERE|FATAL)\b`],
  ["level-warn", String.raw`\b(?:WARNING|WARN)\b`],
  ["level-info", String.raw`\bINFO\b`],
  ["level-debug", String.raw`\b(?:DEBUG|TRACE|FINE|FINER|FINEST)\b`],
  ["thread", String.raw`\((?![\w$]+\.java)[^()\s]+\)`],
  ["class", String.raw`\[[^\[\]\s]+\]`],
  ["number", String.raw`(?<![\w.])\d+(?:\.\d+)?`],
]
const RE = new RegExp(GROUPS.map(([k, p]) => `(?<${k.replace("-", "_")}>${p})`).join("|"), "g")

export function tokenizeLogLine(line: string): LogToken[] {
  const out: LogToken[] = []
  const plain = (text: string) => {
    if (!text) return
    const last = out.at(-1)
    if (last?.kind === "plain") last.text += text
    else out.push({ text, kind: "plain" })
  }
  let pos = 0
  RE.lastIndex = 0
  for (let m = RE.exec(line); m; m = RE.exec(line)) {
    plain(line.slice(pos, m.index))
    const kind = GROUPS.find(([k]) => m.groups?.[k.replace("-", "_")] !== undefined)?.[0] ?? "plain"
    if (kind === "plain") plain(m[0])
    else out.push({ text: m[0], kind })
    pos = m.index + m[0].length
  }
  plain(line.slice(pos))
  return out
}
