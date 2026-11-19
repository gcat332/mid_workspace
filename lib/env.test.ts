import { describe, it, expect } from "vitest"
import { loadEnv } from "./env"

const required = {
  JWT_SECRET: "x".repeat(32),
  MIDHUB_VAULT_KEY: "vault",
  DATABASE_URL: "file:./data/dev.db",
}

describe("loadEnv", () => {
  it("throws listing every missing required var", () => {
    expect(() => loadEnv({})).toThrow(/JWT_SECRET, MIDHUB_VAULT_KEY, DATABASE_URL$/)
  })
  it("no longer needs ADMIN_EMAIL/ADMIN_PASSWORD; old values left in .env.local are ignored", () => {
    expect(() => loadEnv(required)).not.toThrow()
    const e = loadEnv({ ...required, ADMIN_EMAIL: "old@x.com", ADMIN_PASSWORD: "old" })
    expect(Object.keys(e)).not.toContain("adminEmail")
    expect(Object.keys(e)).not.toContain("adminPassword")
  })
  it("applies defaults", () => {
    const e = loadEnv(required)
    expect(e.maxRunning).toBe(4)
    expect(e.midhubRoot).toBe("/opt/midhub")
    expect(e.helperSocket).toBe("/run/midhub/helper.sock")
    expect(e.agenthubUrl).toBe("http://127.0.0.1:3000")
    expect(e.agenthubServiceUser).toBe("bsmagenthub")
  })
  it("AGENTHUB_SERVICE_USER: default bsmagenthub (also when empty); only the literal none disables the listener check", () => {
    expect(loadEnv({ ...required, AGENTHUB_SERVICE_USER: "" }).agenthubServiceUser).toBe("bsmagenthub")
    expect(loadEnv({ ...required, AGENTHUB_SERVICE_USER: "agenthub_svc" }).agenthubServiceUser).toBe("agenthub_svc")
    expect(loadEnv({ ...required, AGENTHUB_SERVICE_USER: "none" }).agenthubServiceUser).toBeNull()
    for (const bad of ["NONE", "a b", "../x", "root:x", "-x"]) {
      expect(() => loadEnv({ ...required, AGENTHUB_SERVICE_USER: bad }), bad).toThrow(/AGENTHUB_SERVICE_USER/)
    }
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
  it("AGENTHUB_URL: loopback http with a port only (127.0.0.1, localhost, [::1]); trailing slash dropped", () => {
    expect(loadEnv({ ...required, AGENTHUB_URL: "http://127.0.0.1:3000/" }).agenthubUrl).toBe("http://127.0.0.1:3000")
    expect(loadEnv({ ...required, AGENTHUB_URL: "http://localhost:4000" }).agenthubUrl).toBe("http://localhost:4000")
    expect(loadEnv({ ...required, AGENTHUB_URL: "http://[::1]:3000" }).agenthubUrl).toBe("http://[::1]:3000")
  })
  it.each([
    "https://127.0.0.1:3000", "http://10.4.150.142:3000", "http://dev-agenthub.mfec.co.th:3000", "http://127.0.0.1",
    "http://127.0.0.1:3000/api", "http://user:pw@127.0.0.1:3000", "http://127.0.0.1.evil.com:3000", "http://127.0.0.2:3000",
    "http://127.0.0.1:0", "http://127.0.0.1:70000", "http://127.0.0.1:3000?x=1", "http://localhost:3000#x", "file:///etc/passwd",
  ])("rejects a non-loopback or odd AGENTHUB_URL (%s)", (u) => {
    expect(() => loadEnv({ ...required, AGENTHUB_URL: u })).toThrow(/AGENTHUB_URL/)
  })
})
