import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, it } from "vitest"

// MidHub has no local login any more (spec: option ข.). Next serves 404 for a path with no route file,
// so "removed" = the route/page file is gone. Nothing else may mint a session but /api/auth/agenthub.
const root = path.resolve(__dirname, "../../..")

it.each([
  "app/api/auth/login/route.ts",
  "app/api/auth/idp/route.ts",
  "app/api/auth/oidc/start/route.ts",
  "app/api/auth/oidc/callback/route.ts",
  "app/api/admin/idp/route.ts",
  "app/admin/idp/page.tsx",
  "components/LoginForm.tsx",
  "components/IdpConfigManager.tsx",
  "lib/db/seed.ts",
])("%s is removed (404)", (f) => {
  expect(existsSync(path.join(root, f))).toBe(false)
})

it("the admin nav no longer links to /admin/idp", () => {
  expect(readFileSync(path.join(root, "components/AdminNav.tsx"), "utf8")).not.toContain("/admin/idp")
})

it("only the AgentHub sign-in route (and the proxy's re-verify) issue a session token", () => {
  const out = execFileSync("/usr/bin/grep", ["-rlE", "signToken\\(", "app", "lib", "proxy.ts", "--include=*.ts", "--include=*.tsx"], { cwd: root, encoding: "utf8" })
  const files = out.split("\n").filter((f) => f && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx")).sort()
  expect(files).toEqual(["app/api/auth/agenthub/route.ts", "lib/auth/jwt.ts", "proxy.ts"])
})
