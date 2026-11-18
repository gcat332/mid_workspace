import { describe, it, expect } from "vitest"
import { loadEnv } from "./env"

const required = {
  JWT_SECRET: "x".repeat(32),
  ADMIN_EMAIL: "a@b.co",
  ADMIN_PASSWORD: "pw",
  MIDHUB_VAULT_KEY: "vault",
  DATABASE_URL: "file:./data/dev.db",
}

describe("loadEnv", () => {
  it("throws listing every missing required var", () => {
    expect(() => loadEnv({})).toThrow(
      /JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, MIDHUB_VAULT_KEY, DATABASE_URL/,
    )
  })
  it("applies defaults", () => {
    const e = loadEnv(required)
    expect(e.maxRunning).toBe(4)
    expect(e.midhubRoot).toBe("/opt/midhub")
    expect(e.helperSocket).toBe("/run/midhub/helper.sock")
    expect(e.adminEmail).toBe("a@b.co")
  })
  it("rejects a short JWT_SECRET", () => {
    expect(() => loadEnv({ ...required, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/)
  })
  it("agentSecret: unset/empty = null (feature off), >= 32 chars accepted, shorter rejected", () => {
    expect(loadEnv(required).agentSecret).toBeNull()
    expect(loadEnv({ ...required, MIDHUB_AGENT_SECRET: "" }).agentSecret).toBeNull()
    expect(loadEnv({ ...required, MIDHUB_AGENT_SECRET: "a".repeat(32) }).agentSecret).toBe("a".repeat(32))
    expect(() => loadEnv({ ...required, MIDHUB_AGENT_SECRET: "a".repeat(31) })).toThrow(/MIDHUB_AGENT_SECRET/)
  })
})
