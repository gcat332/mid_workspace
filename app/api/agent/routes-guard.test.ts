import { it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// proxy.ts exempts /api/agent/* from the cookie gate, so a route here without agentRoute() would be open.
it("every exported HTTP handler under app/api/agent is built with agentRoute", () => {
  const files = readdirSync(__dirname, { recursive: true, encoding: "utf8" }).filter((f) => path.basename(f) === "route.ts")
  for (const f of files) {
    const src = readFileSync(path.join(__dirname, f), "utf8")
    const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1])
    const reexports = /export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(src)
    expect(reexports, `${f}: re-exporting handlers is not allowed here`).toBe(false)
    for (const method of exported) {
      expect(src, `${f}: ${method} must be \`export const ${method} = agentRoute(\``).toMatch(new RegExp(`export\\s+const\\s+${method}\\s*=\\s*agentRoute\\b`))
    }
  }
})
